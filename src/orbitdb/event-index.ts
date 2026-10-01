/**
 * event-index.ts — 事件网络的**可重建索引层** (P2, 2026-10-01)
 *
 * 三个索引 store (keyvalue, 天然可增量复制):
 *   `by-topic`      key = <topic>::<ts>::<eventId>
 *   `by-capability` key = <capability>::<ts>::<eventId>
 *   `by-time`       key = <ts>::<eventId>            (所有事件都进这一条, 时间线)
 *
 * 核心不变式 (本文件存在的全部理由):
 *
 *   ① 索引 = f(事件流), **纯函数**。
 *      `deriveIndexEntries(event)` / `rebuildIndexes(events)` 不读任何索引、不读网络、不读时钟 ——
 *      输入相同 ⇒ 输出逐字节相同。所以「删掉索引 → 重放事件流 → 逐字节相同」是**可判**的,
 *      而且同一结论在任何节点上重复一次都一样 (不需要中心索引)。
 *
 *   ② 索引项**只放元数据 + CID**, 绝不放正文。
 *      `indexEntryFor` 用**显式白名单**构造 IndexEntry (不是展开外壳再删字段 ——
 *      "删字段"会在外壳加字段那天静默漏出正文), 白名单见 `ALLOWED_INDEX_ENTRY_KEYS`。
 *      正文只以 `cid` 出现; 只有**有界摘要** (≤ event-shell 的 MAX_SUMMARY_LEN) 会进索引。
 *
 *   ③ 字节可比。
 *      `indexBundleCbor(bundle)` = dag-cbor 编码的 `{store: {key: value}}` (键排序由 canonicalize 保证),
 *      这就是三个 store 内容的**字节像**; `indexBundleFingerprint` 给它 sha256。
 *      重建前后比这个指纹 = "逐字节相同"。
 */

import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from 'multiformats/hashes/sha2';
import {
  canonicalJson,
  canonicalize,
  MAX_SUMMARY_LEN,
  type EventRef,
  type EventShell,
  type EventType,
} from './event-shell.js';

export const INDEX_STORE_NAMES = ['by-topic', 'by-capability', 'by-time'] as const;
export type IndexStoreName = (typeof INDEX_STORE_NAMES)[number];

/** 索引项版本 (与外壳版本解耦: 索引布局变了就 +1) */
export const INDEX_ENTRY_VERSION = 1;

/**
 * 索引项**只允许**有这些键。反事实门 (verify-event-index ④) 拿它当白名单:
 * 出现集合外的键 = 索引里混进了别的东西。
 */
export const ALLOWED_INDEX_ENTRY_KEYS = [
  'v',
  'id',
  'type',
  'actor',
  'actorId',
  'group',
  'ts',
  'refs',
  'topic',
  'capability',
  'summary',
  'cid',
] as const;

/** 索引项 = 元数据 + CID。**没有 content/body/metadata** */
export interface IndexEntry {
  v: number;
  id: string;
  type: EventType;
  actor: string;
  actorId: string;
  group: string;
  ts: number;
  refs: EventRef[];
  topic?: string;
  capability?: string;
  summary: string;
  cid?: string;
}

export interface DerivedIndexEntry {
  store: IndexStoreName;
  key: string;
  value: IndexEntry;
}

export type IndexBundle = Record<IndexStoreName, DerivedIndexEntry[]>;

const TS_WIDTH = 13; // Date.now() 13 位 (够用到 2286 年); 补零 ⇒ 字符串序 = 时间序

/** key 里的变量部分一律 encodeURIComponent ⇒ 分隔符 `::` 不会被标识符里的字符污染 */
const enc = (s: string): string => encodeURIComponent(s);
const tsPart = (ts: number): string => String(Math.trunc(ts)).padStart(TS_WIDTH, '0');

export function topicKey(ev: { topic?: string; ts: number; id: string }): string | null {
  return ev.topic ? `${enc(ev.topic)}::${tsPart(ev.ts)}::${enc(ev.id)}` : null;
}
export function capabilityKey(ev: { capability?: string; ts: number; id: string }): string | null {
  return ev.capability ? `${enc(ev.capability)}::${tsPart(ev.ts)}::${enc(ev.id)}` : null;
}
export function timeKey(ev: { ts: number; id: string }): string {
  return `${tsPart(ev.ts)}::${enc(ev.id)}`;
}

/** 从 key 反解 (读侧/调试用); 反解不出的返回 null, 不硬凑 */
export function parseIndexKey(
  store: IndexStoreName,
  key: string,
): { label?: string; ts: number; id: string } | null {
  const parts = key.split('::');
  try {
    if (store === 'by-time') {
      if (parts.length !== 2) return null;
      return { ts: Number(parts[0]), id: decodeURIComponent(parts[1]!) };
    }
    if (parts.length !== 3) return null;
    return { label: decodeURIComponent(parts[0]!), ts: Number(parts[1]), id: decodeURIComponent(parts[2]!) };
  } catch {
    return null;
  }
}

/**
 * 外壳 → 索引项。**显式白名单**: 只列出的字段会被搬过来。
 * 这就是"索引项里不许出现正文"在实现层的落实 (不是靠自觉)。
 */
export function indexEntryFor(ev: EventShell): IndexEntry {
  const entry: IndexEntry = {
    v: ev.v ?? INDEX_ENTRY_VERSION,
    id: ev.id,
    type: ev.type,
    actor: ev.actor,
    actorId: ev.actorId,
    group: ev.group,
    ts: ev.ts,
    refs: (ev.refs ?? []).map((r) => (r.rel !== undefined ? { type: r.type, id: r.id, rel: r.rel } : { type: r.type, id: r.id })),
    summary: ev.summary,
  };
  if (ev.topic) entry.topic = ev.topic;
  if (ev.capability) entry.capability = ev.capability;
  if (ev.cid) entry.cid = ev.cid;
  return entry;
}

/** 一个事件 → 它应该出现在哪几个索引里 (topic/capability 缺省就不进对应索引; 时间线一定进) */
export function deriveIndexEntries(ev: EventShell): DerivedIndexEntry[] {
  const value = indexEntryFor(ev);
  const out: DerivedIndexEntry[] = [
    { store: 'by-time', key: timeKey(ev), value },
  ];
  const tk = topicKey(ev);
  if (tk) out.push({ store: 'by-topic', key: tk, value });
  const ck = capabilityKey(ev);
  if (ck) out.push({ store: 'by-capability', key: ck, value });
  return out;
}

function sortDedupe(entries: DerivedIndexEntry[]): DerivedIndexEntry[] {
  const byKey = new Map<string, DerivedIndexEntry>();
  for (const e of entries) byKey.set(e.key, e); // 同 key 后到者胜 (流顺序 ⇒ 确定性)
  return Array.from(byKey.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 纯重建: 事件流 → 三个索引的完整内容。**只依赖输入数组** (无时钟、无网络、无其它 store)。
 * 结果按键排序 + 同键去重 ⇒ 与输入顺序无关 (除非真有同键冲突)。
 */
export function rebuildIndexes(events: readonly EventShell[]): IndexBundle {
  const bundle: IndexBundle = { 'by-topic': [], 'by-capability': [], 'by-time': [] };
  for (const ev of events) for (const d of deriveIndexEntries(ev)) bundle[d.store].push(d);
  for (const name of INDEX_STORE_NAMES) bundle[name] = sortDedupe(bundle[name]);
  return bundle;
}

/** bundle → `{store: {key: value}}` (就是三个 kv store 的内容像) */
export function indexStoreMap(bundle: IndexBundle): Record<string, Record<string, IndexEntry>> {
  const map: Record<string, Record<string, IndexEntry>> = {};
  for (const name of INDEX_STORE_NAMES) {
    const m: Record<string, IndexEntry> = {};
    for (const e of bundle[name]) m[e.key] = e.value;
    map[name] = m;
  }
  return map;
}

/** 索引内容的 canonical JSON (键排序) —— 人可读的"逐字节"版本 */
export function indexBundleCanonicalJson(bundle: IndexBundle): string {
  return canonicalJson(indexStoreMap(bundle));
}

/** 索引内容的 dag-cbor 字节 —— 与 OrbitDB 实际存的编码同一套, 可做真字节比对 */
export function indexBundleCbor(bundle: IndexBundle): Uint8Array {
  const clean = canonicalize(indexStoreMap(bundle));
  return dagCbor.encode(clean as Record<string, unknown>);
}

export interface BundleFingerprint {
  sha256: string;
  bytes: number;
  entries: number;
  perStore: Record<string, number>;
}

/** 内容指纹 (sha256 over dag-cbor 字节) + 计数 —— 重建前后比它 */
export async function indexBundleFingerprint(bundle: IndexBundle): Promise<BundleFingerprint> {
  const bytes = indexBundleCbor(bundle);
  const hash = await sha256.digest(bytes);
  const perStore: Record<string, number> = {};
  for (const name of INDEX_STORE_NAMES) perStore[name] = bundle[name].length;
  return {
    sha256: toHex(hash.digest),
    bytes: bytes.length,
    entries: INDEX_STORE_NAMES.reduce((n, s) => n + bundle[s].length, 0),
    perStore,
  };
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─────────────────── 真 store 侧的口 (结构类型, 不依赖 OrbitDB 实现) ───────────────────

/**
 * 索引 store 的最小接口。`cid-database.ts` 的 `OrbitDBStore` **结构上**满足它 ——
 * 于是本文件可以只在真 OrbitDB 上用、又能在单测里用内存假 store (不必起节点)。
 */
export interface IndexStore {
  readonly address?: string;
  put(key: string, value: unknown): Promise<void>;
  all(): Promise<Array<{ key: string; value: unknown }>>;
  get?(key: string): Promise<unknown>;
  /** 有 del 才能做裁剪; 没有就如实报 skipped (包装层的 OrbitDBStore 目前没暴露 del) */
  del?(key: string): Promise<void>;
}

export interface IndexStoreOpener {
  openStore(name: string, type?: 'keyvalue' | 'events', opts?: { accessController?: { write: string[] } }): Promise<IndexStore>;
}

/** 群/网络共用: 任何成员都可写 (与 gateway-group 的 write:['*'] 一致) */
/**
 * 索引 store 的访问控制 (2026-10-01 收紧)。
 *
 * 之前是 `write: ['*']` —— 任何人可写。索引是**派生数据**, 而且**查询面读的正是它** (event-query.ts)
 * ⇒ 放开的后果不是"多几行垃圾", 而是**查询结果可被投毒**。所以默认收紧成**创建者独占**
 * (@orbitdb/core 的默认语义: 不传 write 列表 ⇒ write=[创建者身份 id])。
 *
 * 要与别人共享同一份索引 (例如由一个可信索引者统一派生、其他人只读), 由调用方显式传写身份。
 *
 * 如实记一条**未做**: 查询面目前**不校验**索引项与事件流的一致性 (P2 的 rebuildIndexes 能重建,
 * 但"读到一份被改过的索引"这件事现在无法被查询侧发现)。要么后续加校验, 要么索引只由本节点自己派生。
 */
export const INDEX_ACCESS = {} as const;

export async function openIndexStores(
  opener: IndexStoreOpener,
  names: readonly IndexStoreName[] = INDEX_STORE_NAMES,
): Promise<Record<IndexStoreName, IndexStore>> {
  const stores = {} as Record<IndexStoreName, IndexStore>;
  for (const name of names) stores[name] = await opener.openStore(name, 'keyvalue', { accessController: { write: ['*'] } });
  return stores;
}

/** 把 bundle 写进真 store (幂等: 同 key 同值覆盖) */
export async function writeBundle(stores: Record<IndexStoreName, IndexStore>, bundle: IndexBundle): Promise<number> {
  let n = 0;
  for (const name of INDEX_STORE_NAMES) {
    for (const e of bundle[name]) {
      await stores[name].put(e.key, e.value);
      n++;
    }
  }
  return n;
}

/** 增量写: 只写这一个事件该写的项 (P4 的日常路径) */
export async function applyEvent(
  stores: Record<IndexStoreName, IndexStore>,
  ev: EventShell,
): Promise<DerivedIndexEntry[]> {
  const derived = deriveIndexEntries(ev);
  for (const d of derived) await stores[d.store].put(d.key, d.value);
  return derived;
}

/**
 * 从真 store 读回全部索引内容 → bundle。
 * 排序 + 去重与 rebuildIndexes 同一套规则 ⇒ 可直接比指纹。
 */
export async function readBundleFromStores(
  stores: Record<IndexStoreName, IndexStore>,
): Promise<IndexBundle> {
  const bundle: IndexBundle = { 'by-topic': [], 'by-capability': [], 'by-time': [] };
  for (const name of INDEX_STORE_NAMES) {
    const all = await stores[name].all();
    for (const e of all) bundle[name].push({ store: name, key: String(e.key), value: e.value as IndexEntry });
  }
  for (const name of INDEX_STORE_NAMES) bundle[name] = sortDedupe(bundle[name]);
  return bundle;
}

/** store 里现有的全部 key (删索引前的留档 / 裁剪用) */
export async function storeKeys(stores: Record<IndexStoreName, IndexStore>): Promise<Record<IndexStoreName, string[]>> {
  const out = {} as Record<IndexStoreName, string[]>;
  for (const name of INDEX_STORE_NAMES) {
    const all = await stores[name].all();
    out[name] = all.map((e) => String(e.key)).sort();
  }
  return out;
}

/**
 * 裁剪: 删掉不在 keep 里的 key。store 没暴露 del 就**如实报 skipped**, 不假装删了。
 */
export async function pruneIndexes(
  stores: Record<IndexStoreName, IndexStore>,
  bundle: IndexBundle,
): Promise<{ removed: number; skipped: string[] }> {
  let removed = 0;
  const skipped: string[] = [];
  for (const name of INDEX_STORE_NAMES) {
    const keep = new Set(bundle[name].map((e) => e.key));
    const store = stores[name];
    const all = await store.all();
    const stale = all.map((e) => String(e.key)).filter((k) => !keep.has(k));
    if (!stale.length) continue;
    if (typeof store.del !== 'function') {
      skipped.push(`${name}: ${stale.length} 个陈旧 key (store 未暴露 del)`);
      continue;
    }
    for (const k of stale) {
      await store.del(k);
      removed++;
    }
  }
  return { removed, skipped };
}

// ─────────────────── 反事实: 索引里有没有正文 ───────────────────

export interface EventLeakDetail {
  id: string;
  entryKeys: string[];
  /** 属于这个事件的全部索引项的字符串叶子 (用来搜正文) */
  entryBytes: number;
  bodyChars: number;
  fullBodyHit: boolean;
  overBudgetHit: boolean;
}

export interface LeakReport {
  /** 索引项里出现的、白名单以外的键 (必须为空) */
  forbiddenKeys: string[];
  /** 索引项里出现"整段正文"的事件数 (必须 0) */
  fullBodyHits: number;
  /** 索引项里出现"超出摘要预算的那段正文"的事件数 (必须 0) */
  overBudgetHits: number;
  checkedEvents: number;
  uncheckedEvents: string[];
  /** 索引里有、但事件流里没有的 id (重建后必须为空 —— 说明有陈旧项没被覆盖) */
  orphanEntryIds: string[];
  maxEntryKeys: number;
  totalIndexBytes: number;
  totalBodyChars: number;
  details: EventLeakDetail[];
}

/** 递归收集一个值里的全部字符串叶子 (正文只可能**整段**落在某个叶子字段里, 不会跨字段拼接) */
function stringLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (typeof v === 'object' && v !== null) for (const k of Object.keys(v as Record<string, unknown>)) stringLeaves((v as Record<string, unknown>)[k], out);
  return out;
}

const MIN_BODY_FOR_FULL_CHECK = 64; // 太短的"正文"没有判据意义
const MIN_TAIL_FOR_CHECK = 32;

/**
 * 反事实检查: 索引项里**有没有正文**。三件事分开报, 不混成一个 bool:
 *   · forbiddenKeys   — 结构面: 出现了白名单以外的键 (比如 content/body/text)
 *   · fullBodyHits    — 内容面: 整段正文出现在索引项的某个字段里
 *   · overBudgetHits  — 长度面: 正文里超过摘要预算 (bodyCharBudget) 的那一段出现在索引里
 * `bodyOf(ev)` 由调用方给 (外壳本身不带正文 —— 这正是设计): 返回 null 表示这个事件没有正文可比。
 */
export function indexLeakReport(
  events: readonly EventShell[],
  bundle: IndexBundle,
  opts: { bodyOf: (ev: EventShell) => string | null; bodyCharBudget?: number },
): LeakReport {
  const budget = opts.bodyCharBudget ?? MAX_SUMMARY_LEN;
  const forbidden = new Set<string>();
  let maxEntryKeys = 0;
  let totalIndexBytes = 0;
  let totalBodyChars = 0;
  let fullBodyHits = 0;
  let overBudgetHits = 0;
  const unchecked: string[] = [];
  const details: EventLeakDetail[] = [];
  const allowed = new Set<string>(ALLOWED_INDEX_ENTRY_KEYS);

  const byEvent = new Map<string, IndexEntry[]>();
  for (const name of INDEX_STORE_NAMES) {
    for (const e of bundle[name]) {
      const list = byEvent.get(e.value.id) ?? [];
      list.push(e.value);
      byEvent.set(e.value.id, list);
    }
  }

  for (const ev of events) {
    const entries = byEvent.get(ev.id) ?? [];
    byEvent.delete(ev.id);
    const leaves: string[] = [];
    const keys: string[] = [];
    let bytes = 0;
    for (const e of entries) {
      for (const k of Object.keys(e)) {
        keys.push(k);
        if (!allowed.has(k)) forbidden.add(k);
      }
      bytes += canonicalJson(e).length;
      stringLeaves(e, leaves);
    }
    maxEntryKeys = Math.max(maxEntryKeys, new Set(keys).size);
    totalIndexBytes += bytes;

    const bodyStr = opts.bodyOf(ev);
    let fullHit = false;
    let tailHit = false;
    if (bodyStr !== null) {
      if (bodyStr.length >= MIN_BODY_FOR_FULL_CHECK) fullHit = leaves.some((s) => s.includes(bodyStr));
      if (bodyStr.length > budget) {
        const tail = bodyStr.slice(budget);
        if (tail.length >= MIN_TAIL_FOR_CHECK) tailHit = leaves.some((s) => s.includes(tail));
      }
    }
    if (fullHit) fullBodyHits++;
    if (tailHit) overBudgetHits++;
    if (bodyStr === null) unchecked.push(ev.id);
    else totalBodyChars += bodyStr.length;
    details.push({
      id: ev.id,
      entryKeys: Array.from(new Set(keys)).sort(),
      entryBytes: bytes,
      bodyChars: bodyStr === null ? 0 : bodyStr.length,
      fullBodyHit: fullHit,
      overBudgetHit: tailHit,
    });
  }

  details.sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    forbiddenKeys: Array.from(forbidden).sort(),
    fullBodyHits,
    overBudgetHits,
    checkedEvents: details.length - unchecked.length,
    uncheckedEvents: unchecked,
    orphanEntryIds: Array.from(byEvent.keys()).sort(),
    maxEntryKeys,
    totalIndexBytes,
    totalBodyChars,
    details,
  };
}
