/**
 * snip-collapse.ts — Phase 2 & 3 (2026-07-29)
 *
 * Claude Code 式: Snip (预算感知裁历史) + Context Collapse (读时虚拟投影)
 *
 * Phase 2 — Snip: 在每次模型调用前, 根据 token 预算裁掉最老的历史.
 *   比 session-window LRU 更强: 保留工具调用链完整性, 不中断 invoke→result 对.
 *
 * Phase 3 — Context Collapse: 读时虚拟投影, 原始 messageHistory 永不破坏.
 *   构建一个"投影"版本: 长工具结果被摘要代替, 模型看到的是压缩版.
 *
 * 两者都不修改 this.messageHistory — 只返回一个新的投影数组.
 */

/** 错误工具结果 / 空内容 最大保留长度 */
const MAX_TOOL_RESULT_SNIP_CHARS = 300;
/** 单条消息最大保留长度 (Budger Reduction) */
const MAX_MESSAGE_SNIP_CHARS = 2000;
/** 工具调用结果投影摘要长度 */
const MAX_COLLAPSED_TOOL_CHARS = 150;

export interface SnipOptions {
  /** 裁到多少条之后, 默认 60 */
  maxMessages?: number;
  /** 预估 token 预算上限, 默认 60000 */
  maxTokens?: number;
  /** 单条消息最大字符数 (Budget Reduction) */
  maxMessageChars?: number;
  /** 工具结果最大字符数 */
  maxToolResultChars?: number;
}

export interface CollapseOptions {
  /** 投影后工具结果最大字符数 */
  maxCollapsedToolChars?: number;
}

export interface CollapsedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** 如果被投影, 原始长度 */
  originalLength?: number;
  /** 投影来源: 'snip' | 'collapse' | 'budget-reduce' */
  transform?: string;
}

/**
 * Phase 2: Snip — 预算感知裁历史.
 * 在系统提示装配前调用, 返回裁剪后的消息数组.
 *
 * 规则:
 * 1. Budget Reduction: 每条消息 content 不超过 maxMessageChars
 * 2. Snip: 如果消息数超过 maxMessages, 从最老的开始裁,
 *    但保留最近的工具调用链 (assistant+tool 对不能拆)
 * 3. 如果即使裁到 maxMessages 条还是太贵, 裁剪工具结果大小
 */
export function snipHistory(
  messages: CollapsedMessage[],
  opts: SnipOptions = {}
): CollapsedMessage[] {
  const maxMessages = opts.maxMessages ?? 60;
  const maxMessageChars = opts.maxMessageChars ?? MAX_MESSAGE_SNIP_CHARS;
  const maxToolResultChars = opts.maxToolResultChars ?? MAX_TOOL_RESULT_SNIP_CHARS;

  if (messages.length === 0) return [];

  // Step 1: Budget Reduction — 每条消息截断到上限
  let budgeted = messages.map(m => {
    if (m.content.length > maxMessageChars) {
      return {
        ...m,
        content: m.content.slice(0, maxMessageChars) + `\n[...截断, 原长 ${m.content.length} 字符]`,
        originalLength: m.content.length,
        transform: 'budget-reduce' as const,
      };
    }
    return m;
  });

  // Step 3 (提前): 窗口内也截断过长 tool 结果 — 2026-08-06 fix: 原来在 Step 2 return 之后,
  //   窗口内消息永远走不到 tool 截断 (budgeted.length <= maxMessages 时提前返回).
  //   originalLength 保留最早值 (budget-reduce 已记录原始长度, 不覆盖).
  const trimToolResults = (list: CollapsedMessage[], boundaryProtected = false): CollapsedMessage[] =>
    list.map(m => {
      if (m.role === 'tool' && m.content.length > maxToolResultChars && m.transform !== 'snip') {
        return {
          ...m,
          content: m.content.slice(0, maxToolResultChars) + `\n[...工具结果截断]`,
          originalLength: m.originalLength ?? m.content.length,
          transform: m.transform || 'snip-tool',
        };
      }
      return m;
    });

  // Step 2: Snip — 超过 maxMessages 时裁最老的
  if (budgeted.length <= maxMessages) return trimToolResults(budgeted);

  const keepCount = maxMessages;
  const toRemove = budgeted.length - keepCount;

  // 2026-08-06 重写: 原实现 protectedToolChain 计数逻辑混乱 (assistant 分支不重置,
  //   条件 `budgeted.length - i > protectedToolChain` 语义错误), 且占位符路径只在
  //   removed<=toRemove 时生效导致被裁消息数与实际不符.
  //   新语义:
  //     - 从头部裁 toRemove 条 (最老历史), 占位区间 = [0, removedIndex)
  //     - 裁剪边界保护: 若保留区第一条是 tool 且前一条是 assistant, assistant 天然在
  //       移除区 → 它变成占位符, 保持 [assistant占位, tool] 相邻, 不产生悬空 tool
  //       (原生 tool_calls 路径要求 assistant→tool 相邻; 占位保留 role 序列形状)
  //     - 被裁消息 → '[已裁减, Snip]' 占位符 (保留 role 顺序, 防配对错乱)
  const result: CollapsedMessage[] = [];
  const removedIndex = budgeted.length - keepCount;  // 保留区起点 (含)

  // 边界保护 (2026-08-06 fix): 只验证不改变 cutAt —
  //   之前 `cutAt -= 1` 把占位区间缩窄, 导致边界 assistant 反而保留 (悬空 tool 依旧).
  //   assistant 本来就在移除区 [0, removedIndex), 转占位后 tool 前紧邻占位 assistant, 配对形状保持.
  const firstKept = budgeted[removedIndex];
  const before = removedIndex > 0 ? budgeted[removedIndex - 1] : undefined;
  // boundaryProtected 仅语义标记 (测试/日志用), 占位区间不变
  const boundaryProtected = firstKept.role === 'tool' && before?.role === 'assistant';
  if (boundaryProtected) { /* 保护生效: tool 前紧邻占位 assistant */ }

  for (let i = 0; i < budgeted.length; i++) {
    if (i < removedIndex) {
      result.push({ ...budgeted[i], content: '[已裁减, Snip]', originalLength: budgeted[i].content.length, transform: 'snip' });
    } else {
      result.push(budgeted[i]);
    }
  }

  // Step 3: 如果 tool result 仍然太长, 进一步截断
  return trimToolResults(result);
}

/**
 * Phase 3: Context Collapse — 读时虚拟投影.
 * 将 verbose 的工具结果替换为摘要, 但不修改原始数据.
 *
 * 适用场景:
 * - 工具返回了很大的 JSON/日志 (> 500 字符)
 * - 模型需要看到"结果", 但不需要完整内容
 * - 原始 messageHistory 依然完整保存在 session store 里
 */
export function collapseContext(
  messages: CollapsedMessage[],
  opts: CollapseOptions = {}
): CollapsedMessage[] {
  const maxChars = opts.maxCollapsedToolChars ?? MAX_COLLAPSED_TOOL_CHARS;

  return messages.map(m => {
    // 只投影 tool role 和特别长的 assistant 消息
    if (m.role === 'tool' && m.content.length > maxChars) {
      const preview = m.content.slice(0, maxChars);
      return {
        ...m,
        content: `${preview}\n[...Context Collapse 投影: 原始 ${m.content.length} 字符, 已压缩为摘要]`,
        originalLength: m.content.length,
        transform: 'collapse',
      };
    }
    // 也投影超长的 assistant 回复 (只保留开头)
    if (m.role === 'assistant' && m.content.length > maxChars * 3) {
      return {
        ...m,
        content: m.content.slice(0, maxChars * 2) + `\n[...回复过长, 已投影, 原始 ${m.content.length} 字符]`,
        originalLength: m.content.length,
        transform: 'collapse',
      };
    }
    return m;
  });
}

/**
 * 组合应用 Snip + Collapse (Claude Code 的 pre-model 管道).
 * 顺序: Budget Reduction → Snip → Context Collapse
 */
export function applyPreModelPipeline(
  messages: CollapsedMessage[],
  snipOpts?: SnipOptions,
  collapseOpts?: CollapseOptions
): CollapsedMessage[] {
  let result = snipHistory(messages, snipOpts);
  result = collapseContext(result, collapseOpts);
  return result;
}
