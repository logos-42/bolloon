/**
 * loop-review.ts — "ReAct loop end" review 续跑决策门
 *
 * 动机 (2026-08-08, v0.3.39):
 *   - LLM 经常"潦草收尾": 达成上一轮成果就输出 <final gen>, 不深挖目标的更多可能.
 *   - 需求: 每次循环结束前 (LLM 想输出 <final gen> 时), 跑 1-2 次「目标对齐 + 需求深挖」,
 *     吐出阶段性成果后再启动 review, 判断"是否还有可能继续触发".
 *   - 天花板: 逻辑上循环能持续最强 (不潦草终止), 时长上限的长循环由迭代上限兜底;
 *     用户明确"结束指标以用户需求为准, 不过度深挖" — 达成用户需求就放行结束.
 *   - 工具调用次数无限制 (不在这里限, 由上层 MAX_REACT_ITERATIONS 兜底).
 *
 * 本模块是纯判定 + 提示文本生成, 不调 LLM. 由 pi-sdk 的 final gen 分支使用:
 *   1. decideAfterReview — 判定 final 前该"续跑 review"还是"真正结束"
 *   2. buildReviewHint    — 构造注入 system 的续跑提示
 *   3. shouldReviewAgain  — 布尔门 (测试/消融用)
 *
 * 设计范式: 与 react-loop.ts 一致 (纯函数), 便于 claude code 独立单测消融边界.
 */

/** review 阶段状态 (来自 runReActLoop 累积) */
export interface ReviewState {
  /** 该次 final 请求前, 已经触发的 review 次数 (0/1/2...) */
  reviewsDone: number;
  /** 用户本轮需求 (2026-08-10: 传原始输入, 供 LLM 对照自查 — 派生 hint 不如原文准) */
  userIntent: string;
  /** 本轮已成功执行过的工具名 (去重), 用于提示"已做到哪些" */
  completedTools: string[];
  /**
   * 2026-08-09: 本轮行动日志 — 比 completedTools 更细, 带结果摘要.
   * 注入 final 前的自查提示, 让 LLM 对照"已完成动作"逐条核查目标,
   * 而不是凭记忆猜 (旧版只有工具名, LLM 容易潦草自查通过).
   */
  actionLog?: { tool: string; argsPreview: string; resultPreview: string; success: boolean }[];
}

/** review 决策结果 */
export type ReviewDecision =
  | { kind: 'continue-review'; hint: string; reason: string }
  | { kind: 'finish'; reason: string };

/** 每轮最多续跑 review 次数 — "运行一两次目标对齐和深挖" (用户明确) */
export const DEFAULT_MAX_REVIEWS = 2;

/**
 * 判定: LLM 想 <final gen> 时, 该续跑一次 review 还是真正结束.
 *
 * 2026-08-10 重构 (用户纠正: 不要硬编码词表, 循环要智能, 自动触发后续):
 *   - 旧逻辑: 无 intent → 直接 finish. 但"发布一个 ipfs 网站..." 被 classifyIntent 误判
 *     chitchat → intentHint 空 → 1 次循环直接 <final gen> (任务没做就结束).
 *   - 新逻辑: **final 前总是让 LLM 自查** (是否完成用户需求/是否还有后续步骤) — 结束权
 *     完全交给 LLM 判断, 规则只做上限兜底 (maxReviews). 达上限才放行, 保证不过度深挖.
 *   - 效果: 任务场景 LLM 自查发现"还没发布" → 自动继续调工具 (自动触发后续);
 *     闲聊场景 LLM 快速确认完成, 2 次自查后放行.
 */
export function decideAfterReview(state: ReviewState, maxReviews: number = DEFAULT_MAX_REVIEWS): ReviewDecision {
  if (state.reviewsDone >= maxReviews) {
    return { kind: 'finish', reason: `max-reviews-${maxReviews}` };
  }
  return {
    kind: 'continue-review',
    reason: `${state.reviewsDone + 1}/${maxReviews} 完成度自查`,
    hint: buildReviewHint(state, maxReviews),
  };
}

/** 构造 review 提示文本 (注入 system context, 让 LLM 深挖或确认完成) */
export function buildReviewHint(state: ReviewState, maxReviews: number = DEFAULT_MAX_REVIEWS): string {
  const intent = (state.userIntent || '').trim() || '(无)';
  const tools = state.completedTools.length ? state.completedTools.join(', ') : '(尚未执行工具)';
  // 2026-08-09: 行动日志 — 逐条列出已完成动作 + 结果摘要, 让 LLM 对照目标核查
  //   (旧版只有工具名, LLM 容易潦草自查; 带结果才能判断"这一步到底做完了没")
  let actionLines = '';
  if (state.actionLog && state.actionLog.length > 0) {
    actionLines = '\n本轮已执行动作 (逐条):\n' + state.actionLog
      .map((a, i) => {
        const args = a.argsPreview ? `(${a.argsPreview.slice(0, 80)})` : '';
        const res = a.success
          ? `✓ ${(a.resultPreview || 'ok').slice(0, 120)}`
          : `✗ ${(a.resultPreview || 'failed').slice(0, 120)}`;
        return `  ${i + 1}. ${a.tool}${args} → ${res}`;
      })
      .join('\n');
  }
  return (
    `[完成度自查 ${state.reviewsDone + 1}/${maxReviews}]` +
    `\n用户需求: ${intent.slice(0, 300)}` +
    actionLines +
    `\n已完成工具: ${tools}` +
    `\n请对照需求逐条自查: 用户需求是否每一项都真正完成了? 如果还有未完成的子目标或自然衔接的后续步骤 → 继续调用工具推进 (已完成动作不要重复, 直接基于已有结果做下一步); ` +
    `如果用户需求已全部满足 → 直接输出 <final gen> 结束.` +
    `\n[重要] 不要因为做了一部分就提前结束 — 结束前逐条对照「用户需求」确认每一项都完成.`
  );
}

/** 布尔门: 是否该继续 review (测试/消融快速断言) */
export function shouldReviewAgain(state: ReviewState, maxReviews: number = DEFAULT_MAX_REVIEWS): boolean {
  return decideAfterReview(state, maxReviews).kind === 'continue-review';
}