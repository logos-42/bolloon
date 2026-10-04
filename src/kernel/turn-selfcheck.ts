/**
 * turn-selfcheck.ts — K10 余项: **回合收尾自检的编排与政策** (从 pi-sdk 的方法体搬进内核)
 *
 * 搬走的是**政策** (不是 I/O):
 *   ① 该不该跑 —— 由纯规则 `decideTypecheck` 决定 (改过 TS 且本回合没跑过), 规则本体在 `code-write-gate.ts`;
 *   ② **系统自检也过门** —— 它不是模型发起的工具调用 (args 恒空, 是本回合改过 TS 后的收尾自检),
 *      但**更不能例外**: 例外一旦靠"没人知道它绕过"活着, 门就不再是唯一的执行咽喉;
 *   ③ **fail-closed**: 门被拒 **或门本身抛错** ⇒ **不执行**, 且要**可见地报出来** (拒绝不许静默);
 *   ④ 执行抛错 ⇒ 报一行"没能跑起来" (附"改动已落盘, 记得自己跑一次"), **绝不让自检失败影响回合结果**。
 *
 * 为什么归内核: 这三条都是**政策**, 不是某个入口的私事 —— 换入口 (CLI/Web/cron) 时不许各写一份。
 * I/O 全部端口注入: 取工具 · 问门 · 上报 (emit)。本模块不 import 任何 agent 侧模块。
 */

import { decideTypecheck, formatTypecheckResult } from './code-write-gate.js';

export interface SelfCheckTool {
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface SelfCheckPorts {
  /** 取工具 (通常是 `tsc_check`) —— 拿不到就等于"这项没得跑", 不算错误 */
  getTool(name: string): SelfCheckTool | undefined;
  /** 问**唯一的门**: 返回判定 (allow + 原因), 不在这里执行任何东西 */
  askGate(req: { tool: string; args: Record<string, unknown> }): Promise<{ allow: boolean; reason?: string; rejectedBy?: string; source?: string }>;
  /** 上报一行状态 (调用方决定去哪: 对话流 / 日志) */
  emit(event: { type: 'status'; content: string; tool: 'system' }): void;
}

export interface SelfCheckOutcome {
  /** 是否**真的执行了**自检 */
  ran: boolean;
  /** 是否走到了"要不要跑"这一层 (false = 本回合不需要跑) —— 调用方据此维护"一轮一次"的状态 */
  decided: boolean;
  /** 被门拒了 (调用方可能想据此上报) */
  rejected?: boolean;
  /** 结果 (仅 ran 时有效): 通过与否 */
  passed?: boolean;
  /** 进对话流的那一行 (空串 = 没上屏) */
  line: string;
  /** 未执行的原因 (被拒 / 工具缺失 / 执行抛错) */
  reason?: string;
}

/** 自检用的工具名 (与工具注册表里的名字一致) */
export const TURN_SELFCHECK_TOOL = 'tsc_check';

/**
 * 回合收尾自检 —— **唯一入口**。语义与迁移前逐条一致:
 *   不需要跑 ⇒ `{decided:false}`; 工具缺失 ⇒ 安静地不做 (迁移前也是静默);
 *   门拒/门抛 ⇒ 不执行 + **上屏一行"被拒, 未执行: 原因"**; 执行成功 ⇒ 上屏一行结果;
 *   执行抛错 ⇒ 上屏一行"没能跑起来"。**本函数从不抛**。
 */
export async function runTurnEndSelfCheck(
  spec: { touched: readonly string[]; ranThisTurn: boolean; toolName?: string },
  ports: SelfCheckPorts,
): Promise<SelfCheckOutcome> {
  if (!decideTypecheck([...spec.touched], spec.ranThisTurn)) {
    return { ran: false, decided: false, line: '' };
  }
  const toolName = spec.toolName ?? TURN_SELFCHECK_TOOL;
  const tool = ports.getTool(toolName);
  if (!tool?.execute) {
    return { ran: false, decided: true, line: '', reason: `工具缺失: ${toolName}` };
  }
  try {
    let allowed = true;
    let why = '';
    try {
      const d = await ports.askGate({ tool: toolName, args: {} });
      allowed = d?.allow === true;
      why = String(d?.reason || d?.rejectedBy || d?.source || '');
    } catch (gateErr) {
      allowed = false;
      why = `harness-error: ${String((gateErr as Error)?.message || gateErr)}`;
    }
    if (!allowed) {
      const line = `🔎 类型检查被门拒绝, 未执行: ${why.slice(0, 120)}`;
      ports.emit({ type: 'status', content: line, tool: 'system' });
      return { ran: false, decided: true, rejected: true, line, reason: why };
    }
    const r = (await tool.execute({})) as { success?: unknown; output?: unknown } | undefined;
    const passed = r?.success !== false && !/error TS\d+/.test(String(r?.output || ''));
    const line = `🔎 ${formatTypecheckResult(passed, String(r?.output || ''))}`;
    ports.emit({ type: 'status', content: line, tool: 'system' });
    return { ran: true, decided: true, passed, line };
  } catch (e) {
    const line = `🔎 类型检查没能跑起来: ${String((e as Error)?.message || e).slice(0, 100)} (改动已落盘, 记得自己跑一次)`;
    ports.emit({ type: 'status', content: line, tool: 'system' });
    return { ran: false, decided: true, line, reason: String((e as Error)?.message || e).slice(0, 120) };
  }
}
