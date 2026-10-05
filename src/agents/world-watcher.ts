/**
 * world-watcher.ts — 世界自动观察器 + 分发主体插槽 (2026-10-05, leo 三条分发规划)
 *
 * ① 自动触发机制: startWorldWatcher() 启动服务端定时扫描 —— AI 持续睁眼观察世界,
 *    不依赖用户打开界面、不依赖按钮。丝滑 = 无人值守, 观察日志自己积累。
 * ② 专门分发主体: 本地版分发主体 = 观察日志 (world/memory/events.jsonl) + 校准环。
 *    未来云端模型/API/专门智能体群 = 换 `dispatchSink` 实现, 接口不变。
 * ③ 用户画像推送: world/profile.json —— 初始化阶段收集 (你是谁/在做什么/标签),
 *    作为常驻意图参与匹配: 无 active intent 时, 画像标签就是意图 (reason=match)。
 */
import { scanOpportunities, type OpportunityCandidate } from './opportunity-match.js';
import { readProfile, setProfile, type WorldProfile } from './world-profile.js';

export { readProfile, setProfile };
export type { WorldProfile };

// ── 自动触发机制 (服务端定时扫描) ─────────────────────────────────────────────
let watcherTimer: NodeJS.Timeout | null = null;
let watching = false; // 防重叠: 上一轮没跑完就跳过这一轮
let watcherCount = 0;

/** 单轮观察: 扫描世界 → 观察日志/校准环自动积累 (分发主体本地版) */
export async function tickWorldWatcher(): Promise<{ ok: boolean; observed: number; count: number; error?: string }> {
  if (watching) return { ok: true, observed: 0, count: watcherCount, error: '上一轮观察未完成, 跳过本轮 (防重叠)' };
  watching = true;
  try {
    const r = await scanOpportunities({ limit: 50 });
    watcherCount += 1;
    return { ok: r.ok, observed: r.results.length, count: watcherCount, error: r.error };
  } finally {
    watching = false;
  }
}

/**
 * 启动世界自动观察器 (服务端启动时调用一次即可; 幂等, 重复调用不叠定时器)。
 * 每 intervalMs (默认 10 分钟) 自动扫描一次 —— 机会进入 AI 视野是主动行为, 不是人触发。
 */
export function startWorldWatcher(intervalMs = 10 * 60 * 1000): { started: boolean; intervalMs: number } {
  if (watcherTimer) return { started: false, intervalMs };
  watcherTimer = setInterval(() => {
    void tickWorldWatcher().catch(() => { /* 观察失败静默, 下一轮再试 */ });
  }, intervalMs);
  // 启动后立刻睁眼一次 (不等第一个周期)
  void tickWorldWatcher().catch(() => {});
  return { started: true, intervalMs };
}

export function stopWorldWatcher(): boolean {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
    return true;
  }
  return false;
}

export function worldWatcherStatus(): { running: boolean; intervalMs: number; ticks: number } {
  return { running: !!watcherTimer, intervalMs: watcherTimer ? 10 * 60 * 1000 : 0, ticks: watcherCount };
}

// ── 分发主体插槽 (未来云端模型/API/专门智能体群换这个实现) ──────────────────
export type DispatchSink = (ops: OpportunityCandidate[]) => Promise<void>;

let dispatchSink: DispatchSink | null = null;

/** 设置分发主体 (本地默认 = 无操作, 观察日志已是记录; 未来接云端 API 换这个) */
export function setDispatchSink(sink: DispatchSink | null): void {
  dispatchSink = sink;
}

export function getDispatchSink(): DispatchSink | null {
  return dispatchSink;
}

/** 手动触发一轮观察并走分发主体 (测试/CLI 用) */
export async function observeWorldOnce(): Promise<{ ok: boolean; observed: number; count: number; error?: string }> {
  const r = await tickWorldWatcher();
  if (dispatchSink && r.observed > 0) {
    // 分发主体吃到的机会 (本地默认无操作; 云端版在这里把机会推给专门智能体群)
    const board = await scanOpportunities({ limit: 20 });
    if (board.ok) await dispatchSink(board.results);
  }
  return r;
}
