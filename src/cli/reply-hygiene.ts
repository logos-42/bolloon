/**
 * reply-hygiene.ts — 「对话回复流」卫生: 内部运行日志不许当消息渲染 (2026-09-27)
 *
 * 起因 (leo): 会话里的**回复流**出现了给开发者看的运行日志 ——
 *   `🔄 开始 ReAct 循环...` · `🧷 运行已登记 (run=…, 预算 60 步 / 30 分钟)` ·
 *   `✅ 处理完成，共 N 次循环` · `🎯 目标仍在进行 (未判完成): …` …
 * 这些行在 Web 面上有自己的去处 (状态栏 / workflow_step), 但 CLI 交互面的 `onStream`
 * **就是对话回复流** —— 在那里它们和用户的结论混在一列消息里, 属于无关信息。
 *
 * 判据的落点 (为什么不在 CLI 里再写一张子串黑名单):
 *   旧的写法是"按内容子串猜"(`content.includes('🔄 循环')`), 于是
 *   `🔄 开始 ReAct 循环...` 这种**说得更早**的一句就漏了 —— 猜不完。
 *   现在由**发送点 (emit) 自己声明** `internal: true` (见 `pi-sdk-types.StreamEvent`),
 *   这里只做一件事: 把这个声明翻成"进不进回复流"的唯一判据。
 *
 * 进不进回复流 ≠ 删掉:
 *   被搬走的行**同一个字**要落 `${BOLLOON_HOME:-~/.bolloon}/logs/startup.log`
 *   (目的地走已有的 `startupLogPath()`, 不新开第二条落盘路径), 并且 `--verbose` / `BOLLOON_VERBOSE=1`
 *   时原样回到屏上 —— 诊断能力一点不丢。
 */
import * as fs from 'fs';
import * as path from 'path';
import { startupLogPath } from './log-gate.js';

/** 内部运行日志在日志文件里的行首标记 (可 grep, 且明确区分于启动日志的其它行) */
export const INTERNAL_RUN_LOG_PREFIX = '[运行] ';

/**
 * 把一行内部运行日志**落盘** (只落盘, 不管上不上屏)。
 *
 * 目的地由**已有**的 `startupLogPath()` 决定 —— 不新开第二条日志路径, 也不自己拼 HOME;
 * 时间戳格式与启动日志保持一致, 于是 `grep '[运行] '` 就能把"从回复流搬走的那批行"原样捞回来。
 */
export function appendInternalRunLog(content: string, tool?: string): void {
  try {
    const p = startupLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${internalRunLogLine(content, tool)}\n`);
  } catch {
    /* 落盘失败绝不影响对话本身 */
  }
}

/**
 * 这条 stream 事件是不是**内部运行日志** —— 是则不进对话回复流, 只落日志文件。
 *
 * 只认 emit 侧的显式声明 (`internal: true`), 不按内容猜:
 * 缺省 (未声明) 一律当"用户可见", 保持既有行为不变。
 */
export function isInternalRunLog(e: { type?: string; internal?: boolean } | null | undefined): boolean {
  return !!e && e.type === 'status' && e.internal === true;
}

/** 内部运行日志落盘时的那一行 (原文一字不改, 只加可 grep 的前缀与来源工具) */
export function internalRunLogLine(content: string, tool?: string): string {
  return `${INTERNAL_RUN_LOG_PREFIX}${tool ? `${tool} · ` : ''}${content}`;
}
