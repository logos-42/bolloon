/**
 * event-query.ts — 事件网络的**查询面** (P4, 2026-10-01)
 *
 * 定位: 1 万 agent 的目标里 "记录可被查询和调用" 是半壁。OrbitDB 只能按 key 迭代, 没有查询面;
 * 本模块把 P2 的三个索引 store (by-topic / by-capability / by-time) 变成可查询的读口,
 * 并且**只出元数据 + CID** —— 正文永远要按 CID 单独取 (L2/L3 分层, 与 cid-database 的惰性取块一致)。
 *
 * 三条硬规则 (都写进判据, 不靠自觉):
 *   ① 同一份索引 + 同一个查询 ⇒ **逐条相同**的结果 (纯函数, 无时钟无网络无随机);
 *   ② 窄范围查询**不许扫全量**: by-time 的 ts 是 13 位补零 ⇒ 字符串序 = 时间序 ⇒ 先用二分定位起点,
 *      再顺序扫到 until 为止 (超出即停), 并如实报 keysRead / keysScanned 两个数;
 *   ③ **没有索引时不许假装成功**: 返回空结果 + 显式 degraded 标注 (reason), 由调用方决定怎么办
 *      (可以从事件流重建索引 —— 那是 P2 的 rebuildIndexes)。
 */
import {
  INDEX_STORE_NAMES,
  parseIndexKey,
  timeKey,
  type IndexBundle,
  type IndexEntry,
  type IndexStoreName,
} from './event-index.js';
import type { EventType } from './event-shell.js';

export interface QuerySpec {
  topic?: string;
  capability?: string;
  /** 闭区间 [since, until] (毫秒); 只影响 by-time 的裁剪 */
  since?: number;
  until?: number;
  actor?: string;
  actorId?: string;
  group?: string;
  type?: EventType | readonly EventType[];
  /** 结果上限 (按时间升序取前 N); 截断时 complete=false */
  limit?: number;
}

export interface QueryResult {
  items: IndexEntry[];
  /** 用哪个索引 (窄范围优先 by-time) */
  store: IndexStoreName;
  /** 从 store 读到的 key 数 (索引项数; 不是正文) */
  keysRead: number;
  /** 本次查询**真正处理**的 key 数 (范围裁剪后) */
  keysScanned: number;
  /** 是否因为 limit 被截断 */
  complete: boolean;
  /** 没有可用索引时的如实降级 (不假装成功) */
  degraded?: { reason: string; hint: string };
}

const TS_WIDTH = 13;
const tsPart = (ts: number): string => String(Math.trunc(ts)).padStart(TS_WIDTH, '0');

/** 选索引: 有时间窗就用 by-time (可裁剪), 否则按 topic / capability */
export function planQuery(q: QuerySpec): IndexStoreName {
  if (q.since !== undefined || q.until !== undefined) return 'by-time';
  if (q.topic) return 'by-topic';
  if (q.capability) return 'by-capability';
  return 'by-time';
}

function matches(entry: IndexEntry, q: QuerySpec): boolean {
  if (q.topic && entry.topic !== q.topic) return false;
  if (q.capability && entry.capability !== q.capability) return false;
  if (q.actor && entry.actor !== q.actor) return false;
  if (q.actorId && entry.actorId !== q.actorId) return false;
  if (q.group && entry.group !== q.group) return false;
  if (q.type) {
    const want = Array.isArray(q.type) ? q.type : [q.type as EventType];
    if (!want.includes(entry.type)) return false;
  }
  if (q.since !== undefined && entry.ts < q.since) return false;
  if (q.until !== undefined && entry.ts > q.until) return false;
  return true;
}

/** 二分: 第一个 ts >= 目标的 key 下标 (by-time 的 key 前缀就是补零 ts) */
function lowerBoundTime(sortedKeys: string[], targetTs: number): number {
  const target = tsPart(targetTs);
  let lo = 0, hi = sortedKeys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sortedKeys[mid] ?? '') < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 纯函数查询: 输入一份索引 (P2 的 IndexBundle), 输出结果 + 真实扫描计数。
 * by-time 的范围裁剪在这里发生 —— 超出 until 立刻停 (不是"全扫一遍再过滤")。
 */
export function queryIndexBundle(bundle: IndexBundle, q: QuerySpec): QueryResult {
  const store = planQuery(q);
  const all = bundle[store] ?? [];
  const keys = all.map((d) => d.key).sort();          // 排序 = 复制一份并排好 (by-time 的 key 天然时间序)
  const byKey = new Map(all.map((d) => [d.key, d.value] as const));

  let keysScanned = 0;
  const out: IndexEntry[] = [];
  const start = q.since !== undefined && store === 'by-time' ? lowerBoundTime(keys, q.since) : 0;

  for (let i = start; i < keys.length; i++) {
    const key = keys[i]!;
    let ts: number;
    try { ts = Number(key.split('::')[0]); } catch { ts = NaN; }
    if (store === 'by-time' && q.until !== undefined && ts > q.until) break;   // ← 早停: 不扫全量
    keysScanned++;
    const parsed = parseIndexKey(store, key);
    if (!parsed) continue;                                                     // 反解不出的不硬凑
    const entry = byKey.get(key);
    if (!entry) continue;
    if (matches(entry, q)) out.push(entry);
  }

  out.sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const limited = q.limit !== undefined && out.length > q.limit ? out.slice(0, q.limit) : out;
  return {
    items: limited,
    store,
    keysRead: keys.length,
    keysScanned,
    complete: q.limit === undefined || out.length <= q.limit,
  };
}

/** 从真 store 的 key 列表构造一个 IndexBundle (读侧用; key 列表由 P2 的 storeKeys 提供) */
export function bundleFromKeys(
  keys: Record<IndexStoreName, string[]>,
  values: Record<IndexStoreName, Record<string, IndexEntry>>,
): IndexBundle {
  const out = {} as IndexBundle;
  for (const store of INDEX_STORE_NAMES) {
    out[store] = (keys[store] ?? []).map((key) => ({ store, key, value: values[store]?.[key]! }))
      .filter((d) => d.value !== undefined && d.value !== null);
  }
  return out;
}

/** 空索引入口: 调用方拿到它必须知道"这是没有索引", 不是"查不到" */
export function emptyIndexDegradation(): QueryResult['degraded'] {
  return {
    reason: 'no-index',
    hint: '这个节点上没有索引项。可以从事件流重建 (event-index.rebuildIndexes) 后重查; 不要把它当"查询结果为空"。',
  };
}

/** 便捷: 全空 bundle */
export function emptyBundle(): IndexBundle {
  return { 'by-topic': [], 'by-capability': [], 'by-time': [] } as IndexBundle;
}

/** 全空 bundle 上的查询 —— 必须带 degraded 标注 (判据 ③) */
export function queryWithoutIndex(q: QuerySpec): QueryResult {
  const r = queryIndexBundle(emptyBundle(), q);
  return { ...r, degraded: emptyIndexDegradation() };
}

export { timeKey };
