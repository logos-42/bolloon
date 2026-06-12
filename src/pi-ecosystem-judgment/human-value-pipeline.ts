/**
 * 判断力自动入库 + AI 演化 统一入口
 *
 * 把新模块 (distill-prompt, evolve-judgment, detect-hook) 集中导出
 * 给 server.ts 和前端调用方一个稳定的入口
 *
 * 旧的 human-value-store.ts (JSON 存储) 和 index.ts (YAML 存储) 不动
 */

export {
  detectIfWorthStoring,
  distillFromConversation,
  evolveWithLLM,
  type DistillTurn,
  type DistillResult,
  type EvolveRelation,
  type EvolveResult,
} from './distill-prompt.js';

export {
  evolveNewJudgment,
  jaccardSimilarity,
  clearEvolveDebounce,
  type EvolveOptions,
  type EvolveOutcome,
} from './evolve-judgment.js';

export {
  detectAndDistillFromChannel,
  distillAndStoreFromChannel,
  throttleDHook,
  clearDHookThrottle,
  type DetectHookOptions,
  type DetectHookResult,
} from './detect-hook.js';
