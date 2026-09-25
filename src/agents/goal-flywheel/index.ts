/**
 * goal-flywheel/index.ts — 「Goal 长期执行飞轮」对外入口 (2026-09-25)
 *
 * 本目录当前**只有冻结的接口类型** (types.ts), 没有任何实现。
 * P0–P4 的实现按 ownership 划分落在本目录各自的新文件里, 逐个从本入口导出:
 *   P0 节奏由进展决定       → continuation-decision.ts
 *   P1 强制收尾飞轮         → run-closure.ts
 *   P1b Memory / Skill 候选 → memory-layers.ts · skill-candidate.ts
 *   P2 子 Agent 工作合同    → work-contract.ts
 *   P3 阻塞监控             → work-monitor.ts
 *   P4 新要求注入           → goal-change.ts
 *
 * 本轮只冻结接口: 不改现有调用方, 不新建任务数据库, 不另起 workflow engine。
 */

export * from './types.js';
