/**
 * chat-segmenter — 把 LLM 原始输出切成结构化 segments (前后端分离核心)
 *
 * 2026-07-01 (v0.2.6): 抽到独立模块. 目标: 前端只渲染, 不做正则.
 *
 * 设计:
 *   后端跑完 LLM 一轮后, 调 segmentChatReply() 把 reply 切成:
 *     [{type: 'think', content: '...'}, {type: 'text', content: '...'}, ...]
 *   然后序列化发给前端, 前端按 type 渲染 — 不知道任何 <invoke> / <function_calls>
 *   /<tool_call> / {tool:...} 这些 LLM 输出格式细节.
 *
 * 与 parse-tool-call.ts 的区别:
 *   - parse-tool-call: 找 **第一个** tool_call, 提取 name+args (用于 dispatch)
 *   - chat-segmenter: 切**整段** reply 为展示 segments, **完全去掉** tool_call 标记
 *                     复用 parse-tool-call 的 tool_call 检测逻辑保证一致性
 *
 * 返回类型: ChatSegment[] 序列化 JSON 给前端:
 *   {type: 'think'|'text'|'env_details'|'tool_call'|'final', content?: string, tool?: {...}}
 *
 * 顺序按 LLM 输出流排, 不重排.
 */

import { parseToolCall } from './parse-tool-call.js';

export type ChatSegmentType = 'think' | 'text' | 'env_details' | 'tool_call' | 'final';

export interface ChatSegment {
  type: ChatSegmentType;
  /** text/think/env_details/final 用 */
  content?: string;
  /** tool_call 用 — 后端看, 前端用来打"已发"打勾 */
  tool?: {
    name: string;
    args: Record<string, string>;
  };
}

export interface SegmenterContext {
  /** 已知 tool names — 用于标记 tool_call segment 的合法性 (跟 parse-tool-call 一致) */
  knownToolNames: Set<string>;
}

/** 切分 LLM 输出. */
export function segmentChatReply(reply: string, ctx: SegmenterContext): ChatSegment[] {
  if (!reply) return [];
  const segments: ChatSegment[] = [];
  let remaining = reply;

  // === 1. 切 <think>...</think> (内容保留, wrap 成 think segment) ===
  remaining = extractAndPush('think', remaining, segments, /<think>([\s\S]*?)<\/think>/g);

  // === 2. 切 <environment_details>...</environment_details> ===
  remaining = extractAndPush('env_details', remaining, segments, /<environment_details>([\s\S]*?)<\/environment_details>/g);

  // === 3. 切 <final gen>...</final gen> 或单 marker ===
  //   final 标记后面是最终答案. 整个切出, 只留 marker 之前的内容作为 text.
  const finalIdx = remaining.indexOf('<final gen>');
  if (finalIdx >= 0) {
    const afterFinal = remaining.substring(finalIdx + '<final gen>'.length).trim();
    if (afterFinal) {
      segments.push({ type: 'final', content: afterFinal });
    }
    remaining = remaining.substring(0, finalIdx).trim();
  }

  // === 4. 切 tool_call 标记 (核心: 完全去掉, 不让前端看到) ===
  //    parse-tool-call 知道怎么定位. 我们做类似但收集 segment.
  remaining = stripToolCallMarkers(remaining, segments, ctx);

  // === 5. 剩余当 text ===
  const textContent = remaining.trim();
  if (textContent) {
    segments.push({ type: 'text', content: textContent });
  }

  return segments;
}

/** 提取正则匹配的 group(1) 内容, 包装为 segment; 原文位置去掉 */
function extractAndPush(
  type: ChatSegmentType,
  text: string,
  out: ChatSegment[],
  re: RegExp
): string {
  // 关键是保留顺序. 用 exec 循环 + lastIndex 累加
  const matches: Array<{ idx: number; len: number; content: string }> = [];
  let m: RegExpExecArray | null;
  // 复制正则避免 lastIndex stateful 污染
  const localRe = new RegExp(re.source, re.flags);
  while ((m = localRe.exec(text)) !== null) {
    matches.push({
      idx: m.index,
      len: m[0].length,
      content: m[1].trim(),
    });
    if (m[0].length === 0) localRe.lastIndex++; // 防无限 loop
  }
  if (matches.length === 0) return text;

  // 反向遍历删除, 同时按原顺序 push
  let next = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { idx, len, content } = matches[i];
    if (!content) continue;
    next = next.substring(0, idx) + next.substring(idx + len);
    // 但 push 是正向, 倒着算 position
  }
  // 重新正向 push
  for (const m of matches) {
    if (m.content) out.push({ type, content: m.content });
  }
  return next;
}

/** 去掉 tool_call 标记 (XML / JSON / Sentinel 各种形式), 留下纯 text. 识别到的 wrap 成 tool_call segment. */
function stripToolCallMarkers(
  text: string,
  out: ChatSegment[],
  ctx: SegmenterContext
): string {
  // 1. 解析 [TOOL_CALL]...[/TOOL_CALL]
  let result = text.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, (m) => {
    const parsed = parseToolCall(m, { tools: ctx.knownToolNames });
    if (parsed) out.push({ type: 'tool_call', tool: { name: parsed.name, args: parsed.args } });
    return '';
  });

  // 2.<tool_call>...</tool_call> (OpenAI Hermes)
  result = result.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, (m) => {
    const parsed = parseToolCall(m, { tools: ctx.knownToolNames });
    if (parsed) out.push({ type: 'tool_call', tool: { name: parsed.name, args: parsed.args } });
    return '';
  });

  // 3. <invoke name="X">...</invoke> (minimax/Hermes)
  result = result.replace(/<invoke\s+name=["']([\w]+)["']>([\s\S]*?)<\/invoke>/g, (_m, name, inner) => {
    if (ctx.knownToolNames.has(name)) {
      const args = extractSimpleArgs(inner);
      out.push({ type: 'tool_call', tool: { name, args } });
    }
    return '';
  });

  // 4. <function_calls>...</function_calls> 整块
  result = result.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, (m) => {
    const parsed = parseToolCall(m, { tools: ctx.knownToolNames });
    if (parsed) out.push({ type: 'tool_call', tool: { name: parsed.name, args: parsed.args } });
    return '';
  });

  // 5. JSON 形式 {"name": "X", "arguments": {...}}
  result = result.replace(
    /\{\s*"name"\s*:\s*"([\w]+)"\s*,\s*"(?:arguments|input|args|params)"\s*:\s*(\{[\s\S]*?\})\s*\}/g,
    (_m, name, argsJson) => {
      if (!ctx.knownToolNames.has(name)) return '';
      let args: Record<string, string> = {};
      try {
        const parsed = JSON.parse(argsJson);
        if (parsed && typeof parsed === 'object') {
          args = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
        }
      } catch {}
      out.push({ type: 'tool_call', tool: { name, args } });
      return '';
    }
  );

  // 6. tool => "X", args => {...}  (Perplexity-style 内部)
  result = result.replace(/\{\s*tool\s*=>\s*["']([\w]+)["']\s*(?:,\s*args\s*=>\s*(\{[\s\S]*?\}))?\s*\}/g, (_m, name, argsJson) => {
    if (!ctx.knownToolNames.has(name)) return '';
    let args: Record<string, string> = {};
    if (argsJson) {
      try {
        const parsed = JSON.parse(argsJson);
        if (parsed && typeof parsed === 'object') {
          args = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
        }
      } catch {}
    }
    out.push({ type: 'tool_call', tool: { name, args } });
    return '';
  });

  // 7. [Function calling]...[/Function calling] 旧 bolloon
  result = result.replace(/\[Function[^\]]*\]\s*/g, '');

  return result;
}

/** 从 <invoke>...</invoke> inner XML 抽 <command> / <args> / <parameter> 简易 args */
function extractSimpleArgs(inner: string): Record<string, string> {
  const args: Record<string, string> = {};
  // <parameter name="X">value</parameter>
  const paramRe = /<parameter\s+name=["'](\w+)["']>([\s\S]*?)<\/parameter>/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(inner)) !== null) {
    args[m[1]] = m[2].trim();
  }
  // <param name="X">value</param>
  if (Object.keys(args).length === 0) {
    const shortRe = /<param\s+name=["'](\w+)["']>([\s\S]*?)<\/param>/g;
    while ((m = shortRe.exec(inner)) !== null) {
      args[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  // <command>X</command> + <args>Y</args>
  if (Object.keys(args).length === 0) {
    const cmdM = inner.match(/<command>([\s\S]*?)<\/command>/);
    const argsM = inner.match(/<args>([\s\S]*?)<\/args>/);
    if (cmdM) {
      const cmd = cmdM[1].trim();
      // auto-split (跟 parse-tool-call 一致: 含空格 → split)
      if (cmd.includes(' ') && !argsM) {
        const parts = cmd.split(/\s+/);
        args.command = parts[0];
        args.args = parts.slice(1).join(' ');
      } else {
        args.command = cmd;
      }
    }
    if (argsM) args.args = argsM[1].trim();
  }
  return args;
}
