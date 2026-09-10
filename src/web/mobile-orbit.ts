/**
 * 手机端 OrbitDB 本地副本 (库级复制 + 双向 merge)
 *
 *   电脑端跑 helia + OrbitDB (@orbitdb/core), 手机端(WebView)跑不了完整 libp2p 栈,
 *   故手机端维护**同一批 store 的本地副本**:
 *     - 拉: GET 电脑端 store 全量条目 → 按确定性 LWW 规则合并进本地副本
 *     - 推: 本地独有的 / 本地胜出的条目 → POST 回电脑端 → 电脑端 put 进 OrbitDB
 *           (OrbitDB keyvalue 本身是 op-log 上的 LWW, 写穿后由它负责跨设备传播)
 *
 *   合并规则 (确定性, 两端各自算必得同一结果 → 收敛):
 *     ① 两边内容哈希相同 → 无变化
 *     ② 值内时间戳 (updatedAt/timestamp/ts) 大者胜
 *     ③ 时间戳相同 → 内容哈希字典序大者胜
 *
 *   本地副本是**离线可用**的: 断网也能读上次同步下来的全部数据.
 */

export interface OrbitEntry { key: string; value: any; hash?: string }

export interface ReplicaEntry { value: any; hash: string; ts: number; origin?: string }

export interface ReplicaStore {
  name: string;
  address?: string;
  entries: Record<string, ReplicaEntry>;
  lastSyncTs: number;
}

export interface ReplicateResult {
  ok: boolean;
  store?: string;
  pulled?: number;
  pushed?: number;
  applied?: number;
  kept?: number;
  total?: number;
  error?: string;
}

const PREFIX = 'bolloon_orbit_replica:';
const URL_KEY = 'bolloon_desktop_base_url';

function ls(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

// ============ 纯函数: 规范化 / 哈希 / 时间戳 ============

/** 递归键排序的稳定 JSON (同内容必得同串) */
export function stableJson(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

/** 内容哈希 (djb2, 手机端自足; 只用于同端两值比较 → 不需要跨端一致) */
export function hashValue(v: any): string {
  const s = stableJson(v);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16) + ':' + s.length.toString(16);
}

/** 值内时间戳 (没有 → 0, 交给哈希序兜底) */
export function valueTs(v: any): number {
  if (!v || typeof v !== 'object') return 0;
  const c = [v.updatedAt, v.timestamp, v.ts, v.createdAt];
  for (const x of c) {
    if (typeof x === 'number' && isFinite(x)) return x;
    if (typeof x === 'string') { const t = Date.parse(x); if (!isNaN(t)) return t; }
  }
  return 0;
}

/** 确定性胜负: 远端内容是否该覆盖本地 */
export function remoteWins(local: ReplicaEntry, remoteValue: any, remoteHash: string): boolean {
  if (local.hash === remoteHash) return false;
  const rTs = valueTs(remoteValue);
  if (rTs !== local.ts) return rTs > local.ts;
  return remoteHash > local.hash;
}

/**
 * 合并一个 store: 本地副本 + 远端条目 → 新副本 / 需推回的条目 / 统计.
 * 纯函数 (不改入参) — 两端各自调用必得同一结果.
 */
export function mergeStore(
  local: Record<string, ReplicaEntry>,
  remote: OrbitEntry[],
  origin = 'desktop',
): { merged: Record<string, ReplicaEntry>; pushed: OrbitEntry[]; applied: number; kept: number } {
  const merged: Record<string, ReplicaEntry> = {};
  for (const [k, e] of Object.entries(local || {})) merged[k] = { ...e };
  let applied = 0;
  let kept = 0;
  const remoteHash = new Map<string, string>();
  for (const r of remote || []) {
    if (!r || typeof r.key !== 'string') continue;
    const h = hashValue(r.value);
    remoteHash.set(r.key, h);
    const cur = merged[r.key];
    if (!cur) {
      merged[r.key] = { value: r.value, hash: h, ts: valueTs(r.value) || Date.now(), origin };
      applied++;
      continue;
    }
    if (remoteWins(cur, r.value, h)) {
      merged[r.key] = { value: r.value, hash: h, ts: valueTs(r.value) || Date.now(), origin };
      applied++;
    } else if (cur.hash !== h) kept++;
  }
  // 本地独有 / 本地胜出 → 推回电脑端
  const pushed: OrbitEntry[] = [];
  for (const [k, e] of Object.entries(merged)) {
    const rh = remoteHash.get(k);
    if (rh === undefined || rh !== e.hash) pushed.push({ key: k, value: e.value });
  }
  return { merged, pushed, applied, kept };
}

// ============ 本地副本读写 ============

export function getReplica(name: string): ReplicaStore {
  try {
    const raw = ls()?.getItem(PREFIX + name);
    if (!raw) return { name, entries: {}, lastSyncTs: 0 };
    const r = JSON.parse(raw) as ReplicaStore;
    return { name, address: r.address, entries: r.entries || {}, lastSyncTs: r.lastSyncTs || 0 };
  } catch {
    return { name, entries: {}, lastSyncTs: 0 };
  }
}

export function saveReplica(r: ReplicaStore): void {
  try { ls()?.setItem(PREFIX + r.name, JSON.stringify(r)); } catch { /* 存储满 → 忽略 */ }
}

/** 手机端本地写 (离线可写): 时间戳取当前 → 同步时胜出并推回电脑端 */
export function replicaPut(name: string, key: string, value: any): ReplicaStore {
  const r = getReplica(name);
  r.entries[key] = { value, hash: hashValue(value), ts: Date.now(), origin: 'phone' };
  saveReplica(r);
  return r;
}

export function replicaAll(name: string): OrbitEntry[] {
  const r = getReplica(name);
  return Object.entries(r.entries).map(([key, e]) => ({ key, value: e.value, hash: e.hash }));
}

export function replicaGet(name: string, key: string): any | null {
  const e = getReplica(name).entries[key];
  return e ? e.value : null;
}

/** 已复制的 store 名列表 (记住曾经同步过的) */
export function replicaNames(): string[] {
  const out: string[] = [];
  try {
    const s = ls();
    if (!s) return out;
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
  } catch { /* 忽略 */ }
  return out;
}

export function replicaStats(): { stores: number; entries: number; lastSyncTs: number; names: string[] } {
  const names = replicaNames();
  let entries = 0;
  let lastSyncTs = 0;
  for (const n of names) {
    const r = getReplica(n);
    entries += Object.keys(r.entries).length;
    lastSyncTs = Math.max(lastSyncTs, r.lastSyncTs || 0);
  }
  return { stores: names.length, entries, lastSyncTs, names };
}

// ============ 与电脑端复制 ============

function baseUrlOf(baseUrl?: string): string {
  try { return String(baseUrl || ls()?.getItem(URL_KEY) || '').trim().replace(/\/+$/, ''); } catch { return ''; }
}

/** 列出电脑端可复制的 store */
export async function listDesktopStores(opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<{ ok: boolean; stores: Array<{ name: string; address?: string }>; error?: string }> {
  const base = baseUrlOf(opts.baseUrl);
  if (!base) return { ok: false, stores: [], error: '未配置电脑端地址' };
  const f = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { ok: false, stores: [], error: '当前环境无 fetch' };
  try {
    const r = await f(`${base}/api/orbitdb/stores`);
    if (!r.ok) return { ok: false, stores: [], error: `电脑端返回 ${r.status}` };
    const j: any = await r.json();
    return { ok: true, stores: (j && j.stores) || [] };
  } catch (e: any) {
    return { ok: false, stores: [], error: e?.message || String(e) };
  }
}

/** 复制单个 store: 拉 → 合并 → 推回. 幂等, 反复调用安全. */
export async function replicateStore(
  name: string,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<ReplicateResult> {
  const base = baseUrlOf(opts.baseUrl);
  if (!base) return { ok: false, store: name, error: '未配置电脑端地址' };
  const f = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { ok: false, store: name, error: '当前环境无 fetch' };
  try {
    // ① 拉电脑端全量
    const gr = await f(`${base}/api/orbitdb/entries?name=${encodeURIComponent(name)}`);
    if (!gr.ok) return { ok: false, store: name, error: `电脑端返回 ${gr.status}` };
    const gj: any = await gr.json();
    if (!gj || gj.ok === false) return { ok: false, store: name, error: (gj && gj.error) || '读取失败' };
    const remote: OrbitEntry[] = Array.isArray(gj.entries) ? gj.entries : [];
    // ② 合并进本地副本
    const local = getReplica(name);
    const { merged, pushed, applied, kept } = mergeStore(local.entries, remote);
    const next: ReplicaStore = { name, address: gj.address || local.address, entries: merged, lastSyncTs: Date.now() };
    saveReplica(next);
    // ③ 推回本地胜出/独有条目 (电脑端 put → OrbitDB 负责后续跨设备传播)
    let pushedN = 0;
    if (pushed.length) {
      const pr = await f(`${base}/api/orbitdb/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, entries: pushed }),
      });
      if (!pr.ok) return { ok: false, store: name, error: `推回失败 ${pr.status}`, pulled: remote.length, applied, kept };
      pushedN = pushed.length;
    }
    return { ok: true, store: name, pulled: remote.length, pushed: pushedN, applied, kept, total: Object.keys(merged).length };
  } catch (e: any) {
    return { ok: false, store: name, error: e?.message || String(e) };
  }
}

/** 复制电脑端全部 store (登录后自动 / 手动同步走这里) */
export async function replicateAll(opts: { baseUrl?: string; fetchImpl?: typeof fetch; stores?: string[] } = {}): Promise<{
  ok: boolean; stores: number; pulled: number; pushed: number; entries: number; error?: string; detail: ReplicateResult[];
}> {
  const detail: ReplicateResult[] = [];
  let names = opts.stores;
  if (!names) {
    const l = await listDesktopStores(opts);
    if (!l.ok) return { ok: false, stores: 0, pulled: 0, pushed: 0, entries: 0, error: l.error, detail };
    names = l.stores.map((s) => s.name).filter(Boolean);
  }
  // 本地已有副本的 store 也要同步 (电脑端列表可能暂时读不到 → 保守保留)
  const all = Array.from(new Set([...(names || []), ...replicaNames()]));
  let pulled = 0;
  let pushed = 0;
  let entries = 0;
  for (const n of all) {
    const r = await replicateStore(n, opts);
    detail.push(r);
    if (r.ok) { pulled += r.pulled || 0; pushed += r.pushed || 0; entries += r.total || 0; }
  }
  const ok = detail.some((d) => d.ok);
  return { ok, stores: all.length, pulled, pushed, entries, error: ok ? undefined : (detail[0] && detail[0].error), detail };
}

export default {
  stableJson, hashValue, valueTs, remoteWins, mergeStore,
  getReplica, saveReplica, replicaPut, replicaAll, replicaGet, replicaNames, replicaStats,
  listDesktopStores, replicateStore, replicateAll,
};
