/**
 * locales/en.ts — English catalog (source of truth)
 *
 * 范围纪律 (Hermes i18n): 只放用户可见静态消息 (审批/护栏/任务系统广播);
 * agent 输出/日志/报错不翻译。
 */
export const catalog = {
  guard: {
    deny_reason: 'Command hit high-risk guard {pattern} (core untouched: privilege escalation / format / delete root / .bolloon data). Try a safer command.',
    self_lifecycle_reason: 'Command would restart or kill the bolloon host service (pattern {pattern}) — this creates a supervisor revival loop. Not allowed.',
    empty: 'Empty command',
  },
  tasks: {
    cancelled: 'Task cancelled: {title}',
    review_pending: 'Task finished execution, awaiting review: {title}',
    approved: 'Task approved: {title}',
    rejected: 'Task rejected, back to queue: {title}',
    failed: 'Task failed: {message}',
    failed_retry: 'Task failed: {message} (auto-retry)',
    parents_undone: 'Task parents not done ({parents}) — cannot execute until parents finish',
    breaker_tripped: 'Failed {count} times consecutively, circuit broken (no auto-retry): {message}',
  },
  claim: {
    busy: 'Another task is currently executing',
    not_claimable: 'Task not claimable (status={status})',
    released: '[task-claim] reclaimed {count} stale claim(s)',
  },
} as const;
