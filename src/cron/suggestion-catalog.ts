/**
 * suggestion-catalog.ts — 内置"下一动作"建议目录
 *
 * 借鉴 Hermes agent suggestion_catalog.py 心智:
 *   - 不是让用户每次从零想"该做什么", 而是提供一组成熟、可一配置就用的自动化/策略建议
 *   - 每个条目是 { dedupKey, title, summary, schedule?, prompt? }
 *   - CLI `/suggestions catalog` 可列出, 用户任选自动装机 (装成 suggestion 或 cron job)
 */

export interface CatalogEntry {
  dedupKey: string;
  title: string;
  summary: string;
  /** 若要同时生成 cron job, 提供调度表达式 */
  schedule?: string;
  /** 若要生成 cron job, 提供执行 prompt */
  prompt?: string;
}

export const SUGGESTION_CATALOG: CatalogEntry[] = [
  {
    dedupKey: 'daily-review',
    title: '每日工作复盘',
    summary: '每天工作结束后 5 分钟, 让 agent 总结当天做的事、遗留事项、并写进 wiki 日志。',
    schedule: '0 18 * * *',
    prompt: '对今天的会话做一次工作复盘: 列出完成的任务、遗留的阻塞项、并追加一行到 wiki 日志。',
  },
  {
    dedupKey: 'weekly-planner',
    title: '每周计划',
    summary: '每周一早上生成本周重点任务清单, 纳入当前计划。',
    schedule: '0 9 * * 1',
    prompt: '生成本周计划: 结合最近 wiki 状态与未完成任务, 列出 3-5 条本周重点。',
  },
  {
    dedupKey: 'wiki-sync',
    title: 'Wiki 一致性检查',
    summary: '定期跑 wiki lint / stale 检查, 发现过期页面就建议修正。',
    schedule: '0 12 * * 5',
    prompt: '运行一次 wiki 一致性检查 (stale_report/wiki_lint), 把发现的过期页面整理成待办建议。',
  },
  {
    dedupKey: 'version-check',
    title: '版本更新检查',
    summary: '定期检查 bolloon 是否有新版本并提示升级。',
    schedule: 'every 1d',
    prompt: '检查 bolloon 是否有新版本, 若有则提示用户升级。',
  },
];

export function findCatalogEntry(dedupKey: string): CatalogEntry | undefined {
  return SUGGESTION_CATALOG.find((c) => c.dedupKey === dedupKey);
}