/**
 * 工具结果的"进上下文"闸 (2026-10-01, 优化方向 #1)。
 *
 * 问题: 工具结果**没有上限** ✗ 就直接进 history, 而 history **每一轮都重放** ⇒ 一条大输出会持续吃上下文。
 * 规矩: 超上限 ⇒ 保留**头 + 尾**(中段信息密度最低) + 把**完整结果落到文件**并把路径给模型
 *   (要看细节就 read_file ⇒ 既省上下文, 又不丢信息 ✓)。
 * 纯函数 + 一个落盘动作; 落盘失败就退化成"只截断"(绝不因此让工具失败 ✓)。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 默认上限: 8000 字符 (够放下绝大多数结果; 超了才走落文件) */
export const DEFAULT_RESULT_MAX_CHARS = 8000;

export interface CappedResult {
  text: string;
  capped: boolean;
  spilledTo?: string;
  originalChars: number;
}

export function resultsDir(home = os.homedir()): string {
  return path.join(home, '.bolloon', 'logs', 'tool-results');
}

/**
 * 头尾保留: head 60% / tail 25%, 留 15% 给提示语 (与出口净化的省略口径一致, 免得两套规矩)。
 */
export function capToolResult(
  text: string,
  opts: { tool: string; maxChars?: number; home?: string; spill?: boolean } = { tool: '?' },
): CappedResult {
  const s = String(text ?? '');
  const max = opts.maxChars ?? DEFAULT_RESULT_MAX_CHARS;
  const originalChars = s.length;
  if (max <= 0 || s.length <= max) return { text: s, capped: false, originalChars };

  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.25);
  let spilledTo: string | undefined;
  if (opts.spill !== false) {
    try {
      const home = opts.home || os.homedir();
      const dir = resultsDir(home);
      fs.mkdirSync(dir, { recursive: true });
      const safeTool = String(opts.tool || 'tool').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40);
      const file = path.join(dir, `${Date.now()}-${safeTool}.txt`);
      fs.writeFileSync(file, s, 'utf-8');
      spilledTo = file;
    } catch { /* 落盘失败就只截断 */ }
  }
  const notice = spilledTo
    ? `\n…[结果过长已截断: 原文 ${originalChars} 字符, 完整内容已存到 ${spilledTo} —— 要看细节用 read_file 读它]…\n`
    : `\n…[结果过长已截断: 原文 ${originalChars} 字符]…\n`;
  return {
    text: `${s.slice(0, head)}${notice}${s.slice(-tail)}`,
    capped: true,
    spilledTo,
    originalChars,
  };
}
