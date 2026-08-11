/**
 * locales/zh.ts — 中文目录 (默认语言)
 * 键集合与占位符必须与 en.ts 一致 — parity 测试断言 (Hermes test_i18n.py 模式).
 */
export const catalog = {
  guard: {
    deny_reason: '命令命中高危护栏 {pattern} (核心不碰: 提权/格式化/删根/.bolloon 数据). 换一条安全命令.',
    self_lifecycle_reason: '命令会重启或杀死 bolloon 宿主服务 (模式 {pattern}) — 会形成 supervisor 复活循环, 不允许.',
    empty: '命令为空',
  },
  tasks: {
    cancelled: '任务已取消: {title}',
    review_pending: '任务执行完成, 待审批: {title}',
    approved: '任务审批通过: {title}',
    rejected: '任务审批驳回, 退回队列: {title}',
    failed: '任务执行失败: {message}',
    failed_retry: '任务执行失败: {message} (自动重试)',
    parents_undone: '任务父依赖未完成 ({parents}) — 父任务完成后才能执行',
    breaker_tripped: '连续失败 {count} 次, 熔断 (不再自动重试): {message}',
  },
  claim: {
    busy: '另一个任务正在执行',
    not_claimable: '任务不可认领 (status={status})',
    released: '[task-claim] 已回收 {count} 个过期认领',
  },
} as const;
