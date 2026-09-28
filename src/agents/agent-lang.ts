/**
 * agents/agent-lang - 智能体交流语言的**声明层**与消息封装层接线
 *
 * 这一层只做三件事:
 *   ① 声明: manifest 里带上 `supportedLangs` (本机支持哪些语言);
 *   ② 出站: 拿"本机声明 + 对端声明"裁决 → 要么真编 (双方 efficode), 要么原文直发;
 *   ③ 入站: 只按对端**声明**的语言分派 —— 声明不是 efficode 的载荷一律不进解码器。
 *
 * 不支持的场景怎么处理 (照 leo 的要求, 不许静默):
 *   - 对端没声明 / 只声明 natural → 自然语言, 记一笔 `fallback=false`
 *   - 本机想要 efficode 但对端没声明 → 回落, 记一笔 `fallback=true` + 原因
 *   - 对端声明了本机不认识的语言字符串 → 回落, 原样呈现, 记 `unknownSide`
 *   - 对端声明 efficode 但本机没声明支持 → 拒绝解码并抛 (绝不硬解)
 */

import type { AgentManifest } from './agent-manifest-protocol.js';
import {
  decodeFromPeer,
  encodeForPeer,
  defaultDeclaredLang,
  negotiateLang,
  recordLangDecision,
  unknownLangNames,
  type IncomingResult,
  type LangDecision,
  type OutgoingResult,
} from '../efficode/negotiate.js';
import { normalizeLang, type AgentLang, type OpSymbol } from '../efficode/index.js';

/** 本机支持的语言声明 (进程内, 由 manifest 装配处设置) */
let localLangs: string[] = [];
/** 本机默认声明 (env 可覆盖; 默认 natural) */
let defaultLang: AgentLang | null = null;

export function setLocalSupportedLangs(langs: unknown): string[] {
  const arr = Array.isArray(langs) ? langs : langs == null ? [] : [langs];
  localLangs = arr.map((x) => String(x).trim()).filter(Boolean);
  return localLangs;
}

export function getLocalSupportedLangs(): string[] {
  return [...localLangs];
}

/** 本机声明 (没显式设置就回落到 env/默认; 声明不变量绝不"猜"成 efficode) */
export function localDeclaredLang(env: NodeJS.ProcessEnv = process.env): AgentLang {
  if (defaultLang) return defaultLang;
  return defaultDeclaredLang(env);
}

export function setLocalDeclaredLang(lang: unknown): AgentLang {
  defaultLang = normalizeLang(lang);
  return defaultLang ?? 'natural';
}

/** 本机要写进 manifest 的声明: 显式语言列表优先, 否则 [默认声明] */
export function manifestLangDeclaration(env: NodeJS.ProcessEnv = process.env): string[] {
  if (localLangs.length) return [...localLangs];
  return [localDeclaredLang(env)];
}

/** 从 manifest 里读对端声明 (老 manifest 没这个字段 → 空数组 = 没声明) */
export function peerLangsOf(manifest?: Partial<AgentManifest> | null): string[] {
  const raw = (manifest as { supportedLangs?: unknown } | null | undefined)?.supportedLangs;
  const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

export interface AgentLangMessage {
  type: 'agent_message';
  payload: { text: string; lang: AgentLang };
  ts: number;
  fromDid: string;
  toDid?: string;
}

export interface BuiltAgentMessage {
  /** 线上帧 (JSON 文本, 与 agent-manifest-protocol 的其它帧同形状) */
  frame: string;
  lang: AgentLang;
  decision: LangDecision;
  /** efficode 分支下的包字节数 */
  bytes: number;
  /** 是否真用了 Efficode 编码 */
  encoded: boolean;
}

/**
 * 出站消息: 双方声明都是 efficode 才编码, 否则原文直发并在帧里如实声明 `lang: 'natural'`。
 */
export function buildAgentMessage(opts: {
  text: string;
  from?: string;
  to?: string;
  /** 对端声明 (manifest.supportedLangs / 直接给的字符串) */
  theirs: unknown;
  /** 本机声明; 不给用 manifestLangDeclaration() */
  mine?: unknown;
  op?: OpSymbol;
  env?: NodeJS.ProcessEnv;
}): BuiltAgentMessage {
  const mine = opts.mine ?? manifestLangDeclaration(opts.env);
  const enc: OutgoingResult = encodeForPeer({ text: opts.text, mine, theirs: opts.theirs, from: opts.from, op: opts.op });
  const frame: AgentLangMessage = {
    type: 'agent_message',
    payload: { text: enc.text, lang: enc.lang },
    ts: Date.now(),
    fromDid: opts.from ?? '',
    ...(opts.to ? { toDid: opts.to } : {}),
  };
  recordLangDecision(enc.decision, { channel: 'agent_message', peer: opts.to });
  return { frame: JSON.stringify(frame), lang: enc.lang, decision: enc.decision, bytes: enc.bytes, encoded: enc.lang === 'efficode' };
}

/** 解析线上帧 (非 agent_message / 坏 JSON → null; 不抛, 调用方按"不是我的帧"处理) */
export function parseAgentMessageFrame(text: string): AgentLangMessage | null {
  try {
    const v = JSON.parse(text) as AgentLangMessage;
    if (!v || v.type !== 'agent_message' || !v.payload || typeof v.payload.text !== 'string') return null;
    return v;
  } catch {
    return null;
  }
}

export interface ReceivedAgentMessage extends IncomingResult {
  fromDid: string;
  toDid?: string;
  /** 对端**声明**的语言原文 (unknown 时为原串) */
  declared: string | null;
  /** 声明里本机不认识的字符串 */
  unknownLangs: string[];
  decision: LangDecision;
}

/**
 * 入站消息: 严格按帧里 `lang` 分派。
 * - `lang: 'efficode'` 且本机也声明 efficode → 真解包 (畸形包抛 EfficodeError)
 * - 其它一切 (含缺字段 / 未知字符串) → 原样文本 + 明确 note, **不进解码器**
 */
export function readAgentMessage(
  frameText: string,
  opts: { mine?: unknown; env?: NodeJS.ProcessEnv } = {}
): ReceivedAgentMessage | null {
  const frame = parseAgentMessageFrame(frameText);
  if (!frame) return null;
  const mine = opts.mine ?? manifestLangDeclaration(opts.env);
  const declared = (frame.payload as { lang?: unknown }).lang;
  const inc = decodeFromPeer({ payload: frame.payload.text, declaredLang: declared, mine });
  const decision = negotiateLang(mine, declared);
  recordLangDecision(decision, { channel: 'agent_message_recv' });
  return {
    ...inc,
    declared: inc.declaredRaw,
    unknownLangs: unknownLangNames(declared),
    fromDid: frame.fromDid ?? '',
    toDid: frame.toDid,
    decision,
  };
}
