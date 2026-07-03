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

  // === 1. 启发式: 开头"让我.../First I'll.../I should..." 句子进 think 段 ===
  //   LLM 偶尔不写 <think> 标签但直接出思考. 启发式: 文本首句以这些模式开头 → think
  //   必须在 step 1 (显式 <think> 切分) 之前 — 因为显式切分 push 完会反序
  if (!remaining.startsWith('<think>')) {
    remaining = extractLeadingThinking(remaining, segments);
  }

  // === 2. 切 <think>...</think> (内容保留, wrap 成 think segment) ===
  remaining = extractAndPush('think', remaining, segments, /<think>([\s\S]*?)<\/think>/g);

  // === 3. 切 <environment_details>...</environment_details> ===
  remaining = extractAndPush('env_details', remaining, segments, /<environment_details>([\s\S]*?)<\/environment_details>/g);

  // === 4. 切 tool_call 标记 (核心: 完全去掉, 不让前端看到) ===
  //   2026-07-01 修: 这步必须在 final 之前 — final 标记之前的 tool_call 是
  //   "LLM 在 final 之前还在调工具", 这部分 content 应进 text (中间过程), 不应进 final.
  remaining = stripToolCallMarkers(remaining, segments, ctx);

  // === 5. 过滤 LLM 填充词 ("好了"/"完成"/"可以" 等单句 text 不上屏) ===
  if (remaining.trim()) {
    remaining = filterFillerText(remaining);
  }

  // === 6. final 之前的 text 段 (中间对话) push — 必须在 final push 之前 ===
  //   注意: 这时 remaining 还含 <final gen> 标记 + 标记后内容. 切 final 前先把 <final gen> 之后内容清掉
  //   实际: 切 final 后再切 text 更清楚
  const finalIdx = remaining.indexOf('<final gen>');
  let beforeFinalText = remaining;
  if (finalIdx >= 0) {
    beforeFinalText = remaining.substring(0, finalIdx);
  }

  const textContent = beforeFinalText.trim();
  if (textContent) {
    segments.push({ type: 'text', content: textContent });
  }

  // === 7. 切 <final gen>...</final gen> (永远最后 push, 渲染时在最后) ===
  if (finalIdx >= 0) {
    const afterFinal = remaining.substring(finalIdx + '<final gen>'.length).trim();
    if (afterFinal) {
      segments.push({ type: 'final', content: afterFinal });
    }
  }

  return segments;
}

/**
 * 修 extractAndPush 的 reverse 删除 bug (2026-07-01)
 *   之前: 用 mutate 后的 next 算切片, idx 错位 → 多 match 时删除错
 *   现在: 用 lastIndex 累加在原文上标记删除区, 最后一次性 slice
 */
function extractAndPush(
  type: ChatSegmentType,
  text: string,
  out: ChatSegment[],
  re: RegExp
): string {
  const matches: Array<{ start: number; end: number; content: string }> = [];
  const localRe = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = localRe.exec(text)) !== null) {
    const content = m[1] ? m[1].trim() : '';
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      content,
    });
    if (m[0].length === 0) localRe.lastIndex++;
  }
  if (matches.length === 0) return text;

  // push 正向 (保顺序)
  for (const m of matches) {
    if (m.content) out.push({ type, content: m.content });
  }

  // 删除: 在原文上基于 start/end 切片, 不在 mutate 后算 idx
  let next = '';
  let cursor = 0;
  for (const m of matches) {
    next += text.substring(cursor, m.start);
    cursor = m.end;
  }
  next += text.substring(cursor);
  return next;
}

/**
 * 启发式: 提取开头的"思考"句子 (2026-07-01 新增)
 *   模式: 文本开头遇到这些起手式, 整句 (到下一个 \n 或 . 或 句号) 切到 think 段
 *   例子:
 *     "让我先想想用户的需求" + 正文 → think(让我先想想用户的需求) + 正文
 *     "First I'll check the project structure" → think(...)
 *   不命中 → 整段保留, 走 text
 */
function extractLeadingThinking(text: string, out: ChatSegment[]): string {
  // 模式 1: 显式/隐式思考句首 (一句到第一个 \n 或 \.\?\! 结束)
  //   "让我..." / "我先..." / "先来..." / "接下来..." / "First, ..." / "I'll ..."
  //   整句进 think, 后续 content 进 text
  // 模式 2: 整行都是思考 (一行 \n 间隔)
  const firstLineEnd = text.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? text : text.substring(0, firstLineEnd);
  const rest = firstLineEnd === -1 ? '' : text.substring(firstLineEnd + 1);

  // 中文/英文思考起手词
  const thinkingStartRe = /^(让我|我先|我应该|先来|先|接下来|好的[,，]?\s*我|让我先|先看看|让我看看|思考|考虑)/;
  const enThinkingStartRe = /^(Let me|I'll|I will|First,|Next,|Now,|So,|Alright[,.]\s+(?:let me|I'll|I will))/i;

  if (firstLine.trim().length === 0) {
    return text; // 空开头不动
  }

  // 单行启发式: 整行 < 120 字符 + 起始 match → 整行进 think
  if (firstLine.length <= 120 && (thinkingStartRe.test(firstLine) || enThinkingStartRe.test(firstLine))) {
    out.push({ type: 'think', content: firstLine.trim() });
    return rest;
  }

  // 多行启发式: 第一段 (到第一个空行) 是思考
  if (firstLine.length <= 80 && (thinkingStartRe.test(firstLine) || enThinkingStartRe.test(firstLine))) {
    out.push({ type: 'think', content: firstLine.trim() });
    return rest;
  }

  return text;
}

/**
 * 过滤 LLM 填充词 (2026-07-01 新增)
 *   单独的"好了"/"完成"/"可以"/"答完了"等单句不显示在气泡
 *   配合 segmentChatReply 步骤 6
 */
function filterFillerText(text: string): string {
  // 整行 = filler 词 → 整行丢
  const lines = text.split('\n');
  const filtered: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // 匹配: 整行 = 填充词 (可带标点)
    if (/^(好|好了|好的|完成|完成了|任务完成|可以|可以了|答完了|说完了|就这样|完了|done|ok|OK|Okay|okay|alright|fine|let me check|我来)\.?$/i.test(t)) {
      continue;
    }
    filtered.push(line);
  }
  return filtered.join('\n').trim();
}

/** 提取正则匹配的 group(1) 内容, 包装为 segment; 原文位置去掉 */
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

  // 8. (2026-07-01) 未闭合的 tool_call 起始标签 (LLM 偶输出截断)
  //   例子: "<tool_call><invoke name="shell_exec"><command>ls</command></invoke>" 缺少 </tool_call>
  //   上面 1-7 步的正则都要求完整闭合对, 不闭合会留残文.
  //   修法: 扫到孤立起始标签 (后面没有匹配的闭合) → 整段删到 \n\n 或 end
  result = stripUnclosedToolCallTags(result);

  return result;
}

/**
 * 删未闭合的 tool_call 起始标签 + 后面到段结束 (2026-07-01)
 *   例子: "<tool_call><invoke name="shell_exec"><command>ls</command></invoke>"
 *   → 检查每个起始标签 (<tool_call>, <invoke, <function_calls, [TOOL_CALL])
 *   → 如果没找到对应闭合, 删整段
 */
function stripUnclosedToolCallTags(text: string): string {
  const startTags: Array<{ tag: string; closeTag: string; openRe: RegExp }> = [
    { tag: '<tool_call>', closeTag: '</tool_call>', openRe: /<tool_call>/g },
    { tag: '<invoke ', closeTag: '</invoke>', openRe: /<invoke\s+name=["']([\w]+)["']>/g },
    { tag: '<function_calls>', closeTag: '</function_calls>', openRe: /<function_calls>/g },
    { tag: '[TOOL_CALL]', closeTag: '[/TOOL_CALL]', openRe: /\[TOOL_CALL\]/g },
  ];
  let result = text;
  for (const { tag, closeTag, openRe } of startTags) {
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(result)) !== null) {
      // 检查 startIdx 之后是否还有 closeTag
      const tail = result.substring(m.index);
      const closeIdx = tail.indexOf(closeTag);
      if (closeIdx === -1) {
        // 未闭合 — 删起始标签 + 之后所有内容 (到 \n\n 或 end)
        const nextBlank = result.indexOf('\n\n', m.index);
        const endIdx = nextBlank === -1 ? result.length : nextBlank;
        result = result.substring(0, m.index) + result.substring(endIdx);
        break; // 重新开始本 tag 扫描
      }
    }
  }
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
