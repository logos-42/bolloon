/**
 * 手机端 ↔ 电脑端 bolloon 数据同步
 *
 *   登录后 (或设置页手动点「立即同步」) 从电脑端一次拉取全部数据快照:
 *     channels (会话) / judgments (判断力) / services (Agent Registry) /
 *     resources (数字资源) / networks (已加入网络) / active (活跃身份)
 *   落到本地 → 手机端离线也能读; 重复调用幂等, 不覆盖手机端本机会话.
 *
 *   依赖: 电脑端 server.ts 的 GET /api/mobile/snapshot (已开 CORS).
 *   地址持久化在 localStorage (与 mobile-gateway 的 desktopBaseUrl 同一个 key).
 */

const URL_KEY = 'bolloon_desktop_base_url';
const SNAP_KEY = 'bolloon_desktop_snapshot';
const JUDGE_KEY = 'bolloon_judgments_cache';

export interface DesktopSnapshot {
  ok: boolean;
  ts?: number;
  source?: string;
  counts?: Record<string, number>;
  active?: any;
  channels?: any[];
  judgments?: any[];
  services?: any[];
  resources?: any[];
  networks?: any[];
}

export interface SyncResult {
  ok: boolean;
  counts?: Record<string, number>;
  ts?: number;
  error?: string;
  /** OrbitDB 库级复制结果 (本地副本 ↔ 电脑端 store) */
  orbit?: { ok: boolean; stores: number; pulled: number; pushed: number; entries: number; error?: string };
}

const ORBIT_KEY = 'bolloon_orbit_status';

function ls(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** 电脑端地址 (如 http://192.168.1.5:7788) — 与 mobile-gateway 共用同一 key */
export function getDesktopUrl(): string {
  try { return ls()?.getItem(URL_KEY) || ''; } catch { return ''; }
}

export function setDesktopUrl(url: string): void {
  try { ls()?.setItem(URL_KEY, String(url || '').trim().replace(/\/+$/, '')); } catch { /* 忽略 */ }
}

export function getLastSnapshot(): DesktopSnapshot | null {
  try { const s = ls()?.getItem(SNAP_KEY); return s ? (JSON.parse(s) as DesktopSnapshot) : null; } catch { return null; }
}

/** 电脑端同步下来的判断力库 (判断力 API 页离线读取) */
export function getCachedJudgments(): any[] {
  try { const s = ls()?.getItem(JUDGE_KEY); const a = s ? JSON.parse(s) : []; return Array.isArray(a) ? a : []; } catch { return []; }
}

export function getSyncStatus(): { url: string; lastTs: number; counts: Record<string, number>; orbit: any } {
  const snap = getLastSnapshot();
  let orbit: any = null;
  try { const s = ls()?.getItem(ORBIT_KEY); orbit = s ? JSON.parse(s) : null; } catch { orbit = null; }
  return { url: getDesktopUrl(), lastTs: (snap && snap.ts) || 0, counts: (snap && snap.counts) || {}, orbit };
}

/** OrbitDB 库级复制: 本地副本 ↔ 电脑端 store (双向 merge). 独立入口, 便于本地写后立即推回. */
export async function replicateOrbit(opts: { fetchImpl?: typeof fetch } = {}): Promise<SyncResult['orbit']> {
  try {
    const o = await import('./mobile-orbit.js');
    const r = await o.replicateAll({ baseUrl: getDesktopUrl(), fetchImpl: opts.fetchImpl });
    const out = { ok: r.ok, stores: r.stores, pulled: r.pulled, pushed: r.pushed, entries: r.entries, error: r.error };
    try { ls()?.setItem(ORBIT_KEY, JSON.stringify(out)); } catch { /* 忽略 */ }
    return out;
  } catch (e: any) {
    const out = { ok: false, stores: 0, pulled: 0, pushed: 0, entries: 0, error: e?.message || String(e) };
    try { ls()?.setItem(ORBIT_KEY, JSON.stringify(out)); } catch { /* 忽略 */ }
    return out;
  }
}

/**
 * 从电脑端拉取全部数据快照并落地本地.
 *   - 未配置地址 → 明确报错 (不静默)
 *   - 网络/解析失败 → 返回 error, 保留上一次快照
 */
export async function syncFromDesktop(baseUrl?: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<SyncResult> {
  const base = String(baseUrl || getDesktopUrl() || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, error: '未配置电脑端地址 (设置 → 电脑端同步)' };
  const f = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { ok: false, error: '当前环境无 fetch' };
  try {
    const r = await f(`${base}/api/mobile/snapshot`, { method: 'GET' });
    if (!r.ok) return { ok: false, error: `电脑端返回 ${r.status}` };
    const snap = (await r.json()) as DesktopSnapshot;
    if (!snap || snap.ok === false) return { ok: false, error: (snap as any)?.error || '快照无效' };
    try { ls()?.setItem(SNAP_KEY, JSON.stringify(snap)); } catch { /* 存储满 → 忽略 */ }
    if (Array.isArray(snap.judgments)) {
      try { ls()?.setItem(JUDGE_KEY, JSON.stringify(snap.judgments)); } catch { /* 忽略 */ }
    }
    // 顺手做 OrbitDB 库级复制 (手机端本地副本 ↔ 电脑端 store, 双向 merge); 失败不影响快照结果
    let orbit: SyncResult['orbit'];
    try {
      const o = await import('./mobile-orbit.js');
      const r = await o.replicateAll({ baseUrl: base, fetchImpl: opts.fetchImpl });
      orbit = { ok: r.ok, stores: r.stores, pulled: r.pulled, pushed: r.pushed, entries: r.entries, error: r.error };
      try { ls()?.setItem(ORBIT_KEY, JSON.stringify(orbit)); } catch { /* 忽略 */ }
    } catch (e: any) {
      orbit = { ok: false, stores: 0, pulled: 0, pushed: 0, entries: 0, error: e?.message || String(e) };
    }
    return { ok: true, counts: snap.counts || {}, ts: snap.ts, orbit };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export default { getDesktopUrl, setDesktopUrl, getLastSnapshot, getCachedJudgments, getSyncStatus, syncFromDesktop };
