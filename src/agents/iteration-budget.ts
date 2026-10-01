/**
 * 迭代预算 (2026-10-01 落实第二轮: 学的是"**可退还**的迭代预算"那套)。
 *
 * 意图: 惩罚**零碎**调用, 奖励**批处理** —— 一次调用干多件事(程序化工具调用)不该吃预算。
 *   用户的抱怨正是"一件小事花太多次工具调用" ⇒ 把预算变成**激励**而不是单纯的刹车。
 * 设计对齐 (只搬约束, 不搬实现):
 *   · `consume()` 扣一次; **`refund()` 还一次** —— 批处理工具(见 REFUNDABLE_TOOLS)调用后归还;
 *   · 每个 agent 一份(父/子各自的 cap 不同);
 *   · 阈值**警告**(默认 80%) ⇒ 提前提示, 而不是到顶了才硬停;
 *   · 非法配置 **fail-open**(坏值当关闭, 绝不因配置坏掉就把 agent 卡死)。
 * 纪律: 这是**记账 + 激励**, 不做硬刹车 —— 循环退出条件仍由调用方决定(它读 effective 值)。
 */
import os from 'node:os';

/**
 * 这些工具"一次调用可顶多次操作" ⇒ 用它换来的迭代要**退还**。
 * 加新工具时问自己: 它能不能在一次调用里做完 N 件事? 能 ⇒ 加进来。
 */
export const REFUNDABLE_TOOLS: ReadonlySet<string> = new Set(['execute_code']);

export interface BudgetCaps { parent: number; subagent: number }

export function capsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetCaps {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  return {
    parent: num(env.BOLLOON_MAX_ITERATIONS, 500),
    subagent: num(env.BOLLOON_SUBAGENT_MAX_ITERATIONS, 50),
  };
}

/** 警告比例: 严格 (0,1) 的有限数; 否则 null = 关闭该功能 (与"只搬约束"一致) */
export function normalizeWarnRatio(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

export function shouldWarn(used: number, maxTotal: number, ratio = 0.8): boolean {
  const r = normalizeWarnRatio(ratio);
  if (r === null || !Number.isFinite(used) || !Number.isFinite(maxTotal) || maxTotal <= 0) return false;
  return used / maxTotal >= r;
}

/** 该工具的调用是否值得退还一次迭代 */
export function isRefundableTool(toolName: unknown): boolean {
  return REFUNDABLE_TOOLS.has(String(toolName ?? '').trim());
}

export class IterationBudget {
  readonly maxTotal: number;
  private _used = 0;
  private _refunded = 0;

  constructor(maxTotal: number) {
    this.maxTotal = Number.isFinite(maxTotal) && maxTotal > 0 ? Math.floor(maxTotal) : Number.POSITIVE_INFINITY;
  }

  /** 尝试消费一次; 返回 false = 预算用尽 (调用方据此收尾) */
  consume(): boolean {
    if (this._used >= this.maxTotal) return false;
    this._used += 1;
    return true;
  }

  /** 归还一次 (批处理工具调用后) —— 这是"奖励批处理"的落点 */
  refund(): void {
    if (this._used > 0) { this._used -= 1; this._refunded += 1; }
  }

  get used(): number { return this._used; }
  get refunded(): number { return this._refunded; }
  get remaining(): number { return Math.max(0, this.maxTotal - this._used); }
  get depleted(): boolean { return this._used >= this.maxTotal; }
  warn(ratio = 0.8): boolean { return shouldWarn(this._used, this.maxTotal, ratio); }

  /** 供 UI/日志: `已用/上限 (退还 N 次)` */
  describe(): string {
    const cap = Number.isFinite(this.maxTotal) ? String(this.maxTotal) : '∞';
    return `${this._used}/${cap}${this._refunded ? ` (退还 ${this._refunded} 次)` : ''}`;
  }
}
