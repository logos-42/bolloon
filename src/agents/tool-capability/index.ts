/**
 * Tool Capability 层 (K1 ④, 2026-10-02 建)
 *
 * **为什么有这一层**: 领域库 (B 类: Wallet / Safe / Polymarket / OpenCLI) **只能经 Tool Capability 接入**,
 * 不许被 prod 代码各自 import —— 否则"谁能拿到领域能力"散落在各个工具实现里, 没人能一眼看清,
 * 也没法在换实现/换发行形态时统一收口 (本仓已经因为这一坨在 `plan-deletion` 里卡住 dist 的删除)。
 *
 * **这一层是唯一知道领域 SDK 路径的地方**:
 *   · `dist` 优先、`src` 回落 (历史两路发行形态) —— 只在这里写一次
 *   · 实际用了哪一路可观测 (`getLastLoadSource()`), 便于测试与排障
 *   · 目标清单是**单一事实源** (`DOMAIN_TARGETS`), 判据直接读它, 不再去 grep 各工具文件
 */
export const DOMAIN_TARGETS = [
  'PolymarketSDK/listMarkets',
  'PolymarketSDK/getMarket',
  'PolymarketSDK/getOrders',
  'PolymarketSDK/createOrder',
  'PolymarketSDK/cancelOrder',
  'SafeSDK/deploySafe',
] as const;

export type DomainTarget = (typeof DOMAIN_TARGETS)[number];

export type DomainLoadSource = 'dist' | 'src';

interface LoadRecord {
  target: DomainTarget;
  source: DomainLoadSource;
}

const lastLoad: { record: LoadRecord | null } = { record: null };

/** 最近一次成功加载走的哪一路 (`dist` 优先 / `src` 回落) —— 观测面, 不是开关 */
export function getLastLoadSource(): LoadRecord | null {
  return lastLoad.record;
}

/**
 * 取一个领域模块。**唯一**拼路径的地方。
 * 抛错即抛错 (调用方决定怎么报) —— 这一层不做"静默降级成空实现"。
 */
export async function loadDomainModule<T = Record<string, unknown>>(target: DomainTarget): Promise<T> {
  if (!(DOMAIN_TARGETS as readonly string[]).includes(target)) {
    throw new Error(`未登记的领域目标: ${target} (要加就改 DOMAIN_TARGETS, 单一事实源)`);
  }
  const distPath = `../../constraint-runtime/dist/tools/${target}.js`;
  const srcPath = `../../constraint-runtime/src/tools/${target}.js`;
  try {
    const mod = (await import(/* @vite-ignore */ distPath)) as T;
    lastLoad.record = { target, source: 'dist' };
    return mod;
  } catch (distErr) {
    try {
      const mod = (await import(/* @vite-ignore */ srcPath)) as T;
      lastLoad.record = { target, source: 'src' };
      return mod;
    } catch (srcErr) {
      throw new Error(
        `领域模块加载失败 ${target}: dist(${String((distErr as Error)?.message || distErr).slice(0, 80)}) / src(${String((srcErr as Error)?.message || srcErr).slice(0, 80)})`,
      );
    }
  }
}
