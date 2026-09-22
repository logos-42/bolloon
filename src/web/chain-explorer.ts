/**
 * chain-explorer.ts — 链上浏览器页面 (P7) 的前端模块
 * =========================================================================
 * 这个文件是 `/explorer` 页面的**唯一前端源** (编译产物 dist/web/chain-explorer.js, 禁手改)。
 * 它刻意与 client.ts (主聊天界面) 隔离: 不读主界面的全局状态, 不引它的模块, 只吃
 * P5 的只读路由 (`/api/chain/index/{status,stats,events,timeline}`)。
 *
 * 前端纪律 (逐条落实, 验收脚本会对着编译产物断言):
 *   · 活动文本**只用 textContent** —— 本文件不出现 innerHTML
 *   · 双语走 `data-zh` / `data-en` 属性 (静态文案) + 运行时 Lang 参数 (动态文案)
 *   · 相对时间只改**文字节点** (不重排 DOM)
 *   · 尊重 `prefers-reduced-motion` (加 cx-reduce 关掉过渡/动画)
 *   · 轮询 + 请求超时 (AbortController) + **失败指数退避**
 *   · 状态区 `aria-live="polite"`
 *   · **不展示 DID / peerId / IP / 钱包地址完整值**: 地址与哈希一律短写 (0x12ab…9f0e),
 *     完整 taskKey 只活在 JS 内存里 (列表行用 data-idx 索引, 不写进 DOM)
 *
 * 可测性: 纯函数 (短写/排序/分页合并/退避/文案) 全部 export, vitest 直接 import 本文件;
 * DOM 部分只在 `mountChainExplorer()` 里跑, 模块顶层没有任何 DOM 访问。
 */

// ── 常量 ────────────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_LIMIT = 25;
export const POLL_INTERVAL_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 4_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
export const FINALITY_TIERS = ['observed', 'confirmed', 'finalized'] as const;
export type Finality = (typeof FINALITY_TIERS)[number];

// ── 类型 (与 P5 的只读路由逐字对齐) ─────────────────────────────────────────

export interface IndexEntry {
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  eventName: string;
  args: Record<string, string>;
  confirmations: number;
  finality: string;
  suspect: boolean;
  suspectReason?: string;
}

export interface Cursor { blockNumber: number; logIndex: number }

export interface IndexPage {
  events: IndexEntry[];
  nextCursor: Cursor | null;
  hasMore: boolean;
  remaining: number;
}

export interface EscrowTimeline {
  taskKey: string;
  state: string | null;
  events: IndexEntry[];
  count: number;
  hasSuspect: boolean;
}

export interface IndexStatus {
  networkName?: string;
  chainId?: number;
  escrowAddress?: string;
  lastSyncedBlock?: number;
  lastSyncedAt?: number | null;
  lastSyncedAgoMs?: number | null;
  headBlock?: number | null;
  entries?: number;
  suspects?: number;
  confirmations?: { confirmed: number; finalized: number };
  deploymentBlock?: number;
  lagFromSnapshot?: number | null;
}

export interface IndexStats {
  entries?: number;
  suspects?: number;
  tasks?: number;
  created?: number;
  proofSubmitted?: number;
  released?: number;
  refunded?: number;
  disputed?: number;
  expired?: number;
  byFinality?: { observed: number; confirmed: number; finalized: number };
  lastSyncedBlock?: number;
  lastSyncedAt?: number | null;
}

export interface ExplorerSnapshot {
  status: 'live' | 'degraded';
  indexStatus: IndexStatus | null;
  stats: IndexStats | null;
  error: string | null;
  fetchedAt: number;
}

// ── 短写 / 脱敏 (全站唯一的地址显示出口) ─────────────────────────────────────

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;

/** 是不是一个完整钱包地址 (20 字节) —— 这种值**不许**整条显示 */
export function isFullAddress(v: unknown): boolean {
  return typeof v === 'string' && HEX40.test(v);
}
/** 是不是一个完整哈希 (32 字节: txHash/blockHash/proofHash/taskKey) */
export function isFullHash(v: unknown): boolean {
  return typeof v === 'string' && HEX64.test(v);
}

/**
 * 短写。地址/哈希 → `0x12ab…9f0e`; 其它长串截断; 短值原样。
 * 例: 0x30fd11a5…  → 0x30fd…9f0e (前后各 4 位 hex)
 */
export function shortHex(v: unknown, head = 4, tail = 4): string {
  const s = String(v ?? '');
  if (HEX40.test(s) || HEX64.test(s)) return `${s.slice(0, 2 + head)}…${s.slice(-tail)}`;
  if (s.length > 24) return `${s.slice(0, 12)}…${s.slice(-6)}`;
  return s;
}

/** args 里优先展示的字段顺序 (其余字段按字母序补齐) */
const ARG_ORDER = [
  'taskKey', 'taskId', 'buyer', 'agent', 'caller', 'to', 'refundedTo', 'amount',
  'by', 'deadline', 'window', 'feeBps', 'proofHash', 'resultHash', 'resultDigest', 'reason',
];

/** args 关键字段 → 短写后的 (key, value) 列表 */
export function summarizeArgs(args: Record<string, string> | null | undefined): Array<{ key: string; value: string }> {
  const a = args || {};
  const keys = Object.keys(a);
  const ordered = [...ARG_ORDER.filter((k) => keys.includes(k)), ...keys.filter((k) => !ARG_ORDER.includes(k)).sort()];
  return ordered.map((k) => ({ key: k, value: shortHex(a[k]) }));
}

/** args 一行文本 (行内展示 + 验收断言用: 断言这里不出现完整地址) */
export function argsText(args: Record<string, string> | null | undefined): string {
  return summarizeArgs(args).map(({ key, value }) => `${key}=${value}`).join(' · ');
}

export function finalityOf(e: { finality?: string } | null | undefined): Finality | 'unknown' {
  const f = String(e?.finality ?? '');
  return (FINALITY_TIERS as readonly string[]).includes(f) ? (f as Finality) : 'unknown';
}

export type EventTone = 'created' | 'proof' | 'released' | 'refunded' | 'disputed' | 'expired' | 'other';

/** 事件名 → 分类 (统计分类与行内标签共用同一张表, 不各写一份) */
export function eventTone(eventName: unknown): EventTone {
  switch (String(eventName || '')) {
    case 'EscrowCreatedV2': return 'created';
    case 'ProofSubmittedV2': return 'proof';
    case 'ReleasedV2': return 'released';
    case 'RefundedV2': return 'refunded';
    case 'DisputedV2': return 'disputed';
    case 'ExpiredV2': return 'expired';
    default: return 'other';
  }
}

/** 一条事件按 (区块号, logIndex) 排序 */
export function compareEntries(a: IndexEntry, b: IndexEntry): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
  if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex;
  return String(a.txHash).localeCompare(String(b.txHash));
}

export function sortEntries(list: IndexEntry[]): IndexEntry[] {
  return [...list].sort(compareEntries);
}

/** cursor 身份 = (blockNumber, logIndex), 也是去重的 key */
export function cursorKey(e: { blockNumber: number; logIndex: number }): string {
  return `${e.blockNumber}:${e.logIndex}`;
}

/**
 * 增量拼接: 已有 + 新到的一页 → 按 cursor 去重 + 排序。
 * 页面「加载更多」和验收脚本的「第一页+第二页 == 全量」都用这一个函数, 不各写一份。
 */
export function mergeEntries(prev: IndexEntry[], next: IndexEntry[]): IndexEntry[] {
  const map = new Map<string, IndexEntry>();
  for (const e of [...prev, ...next]) {
    if (!e || !Number.isInteger(e.blockNumber)) continue;
    map.set(cursorKey(e), e);
  }
  return [...map.values()].sort(compareEntries);
}

/** 分页是否无缝: 第 2 页必须严格从第 1 页 cursor 之后开始 (无重叠/无遗漏的判据) */
export function pageBoundaryIsExact(prev: IndexPage, next: IndexPage): boolean {
  const last = prev.events[prev.events.length - 1];
  const first = next.events[0];
  if (!last || !first) return false;
  return first.blockNumber > last.blockNumber || (first.blockNumber === last.blockNumber && first.logIndex > last.logIndex);
}

// ── 文案 (动态部分按运行时语言出中文/英文) ──────────────────────────────────

export type Lang = 'zh' | 'en';

export function finalityLabel(f: Finality | 'unknown', lang: Lang): string {
  const zh: Record<string, string> = { observed: '观测中', confirmed: '已确认', finalized: '已最终', unknown: '未知' };
  const en: Record<string, string> = { observed: 'observed', confirmed: 'confirmed', finalized: 'finalized', unknown: 'unknown' };
  return (lang === 'zh' ? zh : en)[f] || String(f);
}

export function eventLabel(eventName: unknown, lang: Lang): string {
  const tone = eventTone(eventName);
  const zh: Record<EventTone, string> = {
    created: '托管创建', proof: '提交证明', released: '已放款', refunded: '已退款', disputed: '争议', expired: '已过期', other: '其它',
  };
  const en: Record<EventTone, string> = {
    created: 'escrow created', proof: 'proof submitted', released: 'released', refunded: 'refunded', disputed: 'disputed', expired: 'expired', other: 'other',
  };
  return (lang === 'zh' ? zh : en)[tone];
}

export function formatAgo(ms: number | null | undefined, lang: Lang): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return lang === 'zh' ? '未知' : 'unknown';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return lang === 'zh' ? `${s} 秒前` : `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return lang === 'zh' ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return lang === 'zh' ? `${h} 小时前` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return lang === 'zh' ? `${d} 天前` : `${d}d ago`;
}

export function formatTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 数值渲染: 缺值一律 '—', **绝不**把缺失当 0 (假数据) */
export function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : (v === null || v === undefined ? '—' : String(v));
}

/** 一条事件的整行文本 (页面写的和验收断言的是同一个函数, 不是两套) */
export function renderEntryText(e: IndexEntry): string {
  return [
    `#${num(e.blockNumber)}`,
    `log${num(e.logIndex)}`,
    shortHex(e.txHash),
    String(e.eventName || ''),
    argsText(e.args),
    `${num(e.confirmations)} conf`,
    finalityLabel(finalityOf(e), 'en'),
  ].join(' | ');
}

/** 空态文案: 索引里查不到就说查不到, 不编造 */
export function emptyTimelineText(taskKeyShort: string, lang: Lang): string {
  return lang === 'zh'
    ? `${taskKeyShort}: 索引里没有这个 taskKey 的事件 (不是"状态未知", 是"从未出现")`
    : `${taskKeyShort}: no events for this taskKey in the index (not "unknown state" — never seen)`;
}

export function noIndexText(lang: Lang): string {
  return lang === 'zh'
    ? '索引为空或尚未同步 (索引器还没扫过链上事件)'
    : 'index is empty or not synced yet (indexer has not scanned any events)';
}

// ── 退避 ────────────────────────────────────────────────────────────────────

/** 第 attempt 次失败后的等待时长 (attempt 从 0 开始): 1s, 2s, 4s … 封顶 30s */
export function backoffDelayMs(attempt: number, base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS): number {
  const a = Math.max(0, Math.min(20, Math.floor(Number.isFinite(attempt) ? attempt : 0)));
  return Math.min(cap, base * 2 ** a);
}

// ── 取数 (全部走 AbortController 超时; 失败**抛出**, 由调用方决定降级) ──────

export type FetchLike = (input: string, init?: any) => Promise<any>;

function joinBase(apiBase: string): string {
  return String(apiBase || '').replace(/\/+$/, '');
}

export async function getJSON(url: string, fetchImpl: FetchLike, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: any = null;
  if (ctl) timer = setTimeout(() => { try { ctl.abort(); } catch { /* noop */ } }, timeoutMs);
  try {
    const r = await fetchImpl(url, ctl ? { signal: ctl.signal, headers: { accept: 'application/json' } } : { headers: { accept: 'application/json' } });
    if (!r || typeof r.ok !== 'boolean') throw new Error('无响应');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 首屏快照: 索引高度 / 最后同步时间 / 全量统计。
 * **失败就是 degraded, 且 indexStatus/stats 一律 null** —— 页面据此显示显式降级态,
 * 而不是把 0 当数字显示出来。
 */
export async function fetchSnapshot(
  apiBase: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<ExplorerSnapshot> {
  const f = opts.fetchImpl || (globalThis as any).fetch;
  const t = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const base = joinBase(apiBase);
  const fetchedAt = Date.now();
  if (typeof f !== 'function') return { status: 'degraded', indexStatus: null, stats: null, error: '当前环境没有 fetch', fetchedAt };
  try {
    const [s, st] = await Promise.all([
      getJSON(`${base}/api/chain/index/status`, f, t),
      getJSON(`${base}/api/chain/index/stats`, f, t),
    ]);
    if (!s?.ok || !st?.ok) throw new Error('接口返回 ok=false');
    return { status: 'live', indexStatus: s.status || {}, stats: st.stats || {}, error: null, fetchedAt };
  } catch (e: any) {
    return { status: 'degraded', indexStatus: null, stats: null, error: String(e?.message || e).slice(0, 200), fetchedAt };
  }
}

/** 按 cursor 拉一页 (cursor=null → 从头) */
export async function fetchPage(
  apiBase: string,
  cursor: Cursor | null,
  opts: { limit?: number; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<IndexPage> {
  const f = opts.fetchImpl || (globalThis as any).fetch;
  const q = new URLSearchParams();
  if (cursor) { q.set('blockNumber', String(cursor.blockNumber)); q.set('logIndex', String(cursor.logIndex)); }
  q.set('limit', String(opts.limit ?? DEFAULT_PAGE_LIMIT));
  const j = await getJSON(`${joinBase(apiBase)}/api/chain/index/events?${q.toString()}`, f, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  if (!j?.ok) throw new Error('接口返回 ok=false');
  const p = j.page || {};
  return {
    events: Array.isArray(p.events) ? p.events : [],
    nextCursor: p.nextCursor || null,
    hasMore: !!p.hasMore,
    remaining: Number(p.remaining ?? 0),
  };
}

/** 单个 escrow 的时间线 */
export async function fetchTaskTimeline(
  apiBase: string,
  taskKey: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<EscrowTimeline> {
  const f = opts.fetchImpl || (globalThis as any).fetch;
  const j = await getJSON(`${joinBase(apiBase)}/api/chain/index/timeline?taskKey=${encodeURIComponent(taskKey)}`, f, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  if (!j?.ok) throw new Error('接口返回 ok=false');
  const t = j.timeline || {};
  return {
    taskKey: String(t.taskKey || taskKey),
    state: t.state ?? null,
    events: Array.isArray(t.events) ? t.events : [],
    count: Number(t.count ?? 0),
    hasSuspect: !!t.hasSuspect,
  };
}

// ── DOM 层 (只有 mountChainExplorer 会碰; 模块顶层不碰 DOM) ─────────────────

export interface MountOptions {
  apiBase?: string;
  pollMs?: number;
  pageLimit?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  win?: any;
}

const isTaskKey = (v: unknown): boolean => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * 挂载页面逻辑。返回一个销毁函数 (清定时器)。
 * 幂等: 没有 #chain-explorer-root 就什么都不做 (方便同一个 bundle 被别的页复用时无副作用)。
 */
export function mountChainExplorer(opts: MountOptions = {}): () => void {
  const win: any = opts.win || (globalThis as any);
  const doc: any = win.document;
  if (!doc) return () => {};
  const root: any = doc.getElementById('chain-explorer-root');
  if (!root) return () => {};

  const fetchImpl: FetchLike = opts.fetchImpl || win.fetch?.bind(win);
  const pollMs = opts.pollMs ?? POLL_INTERVAL_MS;
  const pageLimit = opts.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let query: any = null;
  try { query = new URLSearchParams(win.location?.search || ''); } catch { query = null; }
  const apiBase = String(opts.apiBase ?? query?.get('apiBase') ?? root.getAttribute('data-api-base') ?? '');
  const base = apiBase.replace(/\/+$/, '');

  let lang: Lang = 'zh';
  try {
    const stored = win.localStorage?.getItem('bolloon-lang');
    const nav = String(win.navigator?.language || '');
    lang = stored === 'en' || stored === 'zh' ? stored : (nav.toLowerCase().startsWith('en') ? 'en' : 'zh');
  } catch { lang = 'zh'; }

  const state = {
    snapshot: null as ExplorerSnapshot | null,
    entries: [] as IndexEntry[],
    cursor: null as Cursor | null,
    hasMore: false,
    loading: false,
    failStreak: 0,
    taskKey: null as string | null,
    taskEvents: [] as IndexEntry[],
    taskState: null as string | null,
    taskLoaded: false,
    remaining: 0,
    timer: null as any,
    disposed: false,
  };

  const el = (id: string): any => doc.getElementById(id);
  const put = (id: string, text: string) => { const n = el(id); if (n) n.textContent = text; };
  const show = (id: string, on: boolean) => { const n = el(id); if (n) n.style.display = on ? '' : 'none'; };
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);

  // 静态文案 (data-zh / data-en) —— 只改文字节点
  function applyLang() {
    doc.documentElement?.setAttribute?.('lang', lang === 'zh' ? 'zh-CN' : 'en');
    const nodes = doc.querySelectorAll('[data-zh]');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const v = n.getAttribute(lang === 'zh' ? 'data-zh' : 'data-en');
      if (v !== null) n.textContent = v;
    }
    put('cx-lang', lang === 'zh' ? '中文 / EN' : 'EN / 中文');
    renderHeader();
    renderRows();
    renderTask();
  }

  // 首屏状态区 (aria-live)
  function setPageState(kind: 'loading' | 'live' | 'degraded', detail: string) {
    const n = el('cx-state');
    if (n) n.textContent = detail;
    doc.documentElement?.setAttribute?.('data-cx-status', kind);
    const dot = el('cx-state-dot');
    if (dot) dot.className = `cx-dot cx-dot-${kind}`;
  }

  function renderHeader() {
    const s = state.snapshot;
    const live = s?.status === 'live';
    show('cx-degraded', !live && !!s);
    if (!s) { setPageState('loading', t('加载中…', 'loading…')); return; }
    if (!live) {
      setPageState('degraded', t('后端不可用 (降级态)', 'backend unavailable (degraded)'));
      put('cx-degraded-reason', t('原因: ', 'reason: ') + String(s.error || t('未知', 'unknown')));
      // 降级: 不给数字 (0 会被当成真值)
      for (const id of ['cx-height', 'cx-head', 'cx-lastsync', 'cx-entries', 'cx-tasks', 'cx-created',
        'cx-proof', 'cx-released', 'cx-refunded', 'cx-disputed', 'cx-expired',
        'cx-final-observed', 'cx-final-confirmed', 'cx-final-finalized', 'cx-suspects', 'cx-escrow', 'cx-chain']) {
        put(id, '—');
      }
      put('cx-lastsync', t('— (后端不可用)', '— (backend down)'));
      return;
    }
    const st: IndexStatus = s.indexStatus || {};
    const stats: IndexStats = s.stats || {};
    put('cx-height', num(st.lastSyncedBlock));
    put('cx-head', num(st.headBlock));
    put('cx-lastsync', st.lastSyncedAt == null
      ? t('从未同步', 'never synced')
      : `${formatAgo(st.lastSyncedAgoMs ?? (Date.now() - Number(st.lastSyncedAt)), lang)} (${formatTime(Number(st.lastSyncedAt))})`);
    put('cx-entries', num(stats.entries));
    put('cx-tasks', num(stats.tasks));
    put('cx-created', num(stats.created));
    put('cx-proof', num(stats.proofSubmitted));
    put('cx-released', num(stats.released));
    put('cx-refunded', num(stats.refunded));
    put('cx-disputed', num(stats.disputed));
    put('cx-expired', num(stats.expired));
    const bf: any = stats.byFinality || {};
    for (const f of FINALITY_TIERS) put(`cx-final-${f}`, num(bf[f]));
    put('cx-suspects', num(stats.suspects));
    put('cx-escrow', shortHex(st.escrowAddress));
    put('cx-chain', `${st.networkName || '—'} · chainId ${num(st.chainId)}`);
    const empty = (stats.entries ?? 0) === 0;
    setPageState('live', empty
      ? t('后端在线 · 索引为空', 'backend live · index empty')
      : `${t('后端在线 · 索引高度', 'backend live · height')} ${num(st.lastSyncedBlock)} · ${num(stats.entries)} ${t('条事件', 'events')}`);
  }

  function rowNode(e: IndexEntry, idx: number): any {
    const li = doc.createElement('li');
    li.className = 'cx-row';
    li.setAttribute('data-idx', String(idx));
    li.setAttribute('data-finality', finalityOf(e));
    li.setAttribute('data-tone', eventTone(e.eventName));

    const mk = (cls: string, text: string): any => {
      const s = doc.createElement('span');
      s.className = cls;
      s.textContent = text;
      return s;
    };
    li.appendChild(mk('cx-block', `#${num(e.blockNumber)}:${num(e.logIndex)}`));
    li.appendChild(mk('cx-tx', shortHex(e.txHash)));
    li.appendChild(mk('cx-task', shortHex(e.args?.taskKey)));
    li.appendChild(mk('cx-event', `${String(e.eventName || '')} · ${eventLabel(e.eventName, lang)}`));
    li.appendChild(mk('cx-args', argsText(e.args)));
    li.appendChild(mk('cx-conf', `${num(e.confirmations)} conf`));
    const badge = mk(`cx-badge cx-badge-${finalityOf(e)}`, finalityLabel(finalityOf(e), lang));
    li.appendChild(badge);
    if (e.suspect) li.appendChild(mk('cx-suspect', t('被回退', 'reverted')));
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cx-link';
    btn.textContent = t('看时间线', 'timeline');
    if (isTaskKey(e.args?.taskKey)) {
      // 完整 taskKey 只留在闭包里, 不写进 DOM 属性
      btn.addEventListener('click', () => { void openTask(String(e.args.taskKey)); });
    } else {
      btn.disabled = true;
    }
    li.appendChild(btn);
    return li;
  }

  function renderRows() {
    const body = el('cx-timeline-body');
    if (!body) return;
    body.textContent = '';
    if (!state.entries.length) {
      const li = doc.createElement('li');
      li.className = 'cx-empty';
      li.id = 'cx-timeline-empty';
      li.textContent = state.snapshot?.status === 'degraded'
        ? t('后端不可用, 未加载任何事件 (降级态, 不显示假数据)', 'backend unavailable — nothing loaded (degraded, no fabricated rows)')
        : noIndexText(lang);
      body.appendChild(li);
    } else {
      state.entries.forEach((e, i) => body.appendChild(rowNode(e, i)));
    }
    put('cx-timeline-count', t(`已加载 ${state.entries.length} 条`, `${state.entries.length} loaded`));
    const more = el('cx-more');
    if (more) {
      more.disabled = state.loading || !state.hasMore;
      more.textContent = state.loading
        ? t('加载中…', 'loading…')
        : (state.hasMore ? t('加载更多 (按 cursor 取下一段)', 'load more (next cursor)') : t('已到底 (无更多)', 'end of index'));
      more.style.display = state.entries.length || state.hasMore ? '' : 'none';
    }
    const rem = el('cx-remaining');
    if (rem) rem.textContent = state.hasMore ? t(`还有 ${state.remaining - state.entries.length} 条`, `${state.remaining - state.entries.length} more`) : '';
  }

  function renderTask() {
    const body = el('cx-task-body');
    if (!body) return;
    body.textContent = '';
    const title = el('cx-task-title');
    if (!state.taskKey) {
      if (title) title.textContent = t('(未选择)', '(none selected)');
      const hint = doc.createElement('li');
      hint.className = 'cx-empty';
      hint.textContent = t('点上面任意一行的「看时间线」, 或粘贴一个 taskKey', 'Click "timeline" on any row, or paste a taskKey');
      body.appendChild(hint);
      return;
    }
    const short = shortHex(state.taskKey);
    if (title) title.textContent = `${short} · ${state.taskState ? state.taskState : t('状态未知', 'state unknown')}`;
    if (!state.taskLoaded) {
      const li = doc.createElement('li');
      li.className = 'cx-empty';
      li.textContent = t('加载中…', 'loading…');
      body.appendChild(li);
      return;
    }
    if (!state.taskEvents.length) {
      const li = doc.createElement('li');
      li.className = 'cx-empty';
      li.id = 'cx-task-empty';
      li.textContent = emptyTimelineText(short, lang);
      body.appendChild(li);
      return;
    }
    state.taskEvents.forEach((e, i) => body.appendChild(rowNode(e, i)));
  }

  // ── 取数动作 ──────────────────────────────────────────────────────────────

  async function refreshHeader(): Promise<boolean> {
    const snap = await fetchSnapshot(base, { fetchImpl, timeoutMs });
    state.snapshot = snap;
    if (snap.status === 'live') state.failStreak = 0; else state.failStreak++;
    renderHeader();
    return snap.status === 'live';
  }

  async function loadMore(): Promise<void> {
    if (state.loading) return;
    state.loading = true;
    renderRows();
    try {
      const page = await fetchPage(base, state.cursor, { limit: pageLimit, fetchImpl, timeoutMs });
      state.entries = mergeEntries(state.entries, page.events);
      state.cursor = page.nextCursor || state.cursor;
      state.hasMore = page.hasMore;
      state.remaining = page.remaining;
      state.failStreak = 0;
    } catch (e: any) {
      state.failStreak++;
      const lede = el('cx-timeline-lede');
      if (lede) lede.textContent = t('加载失败: ', 'load failed: ') + shortHex(String(e?.message || e));
    } finally {
      state.loading = false;
      renderRows();
    }
  }

  async function openTask(taskKey: string): Promise<void> {
    state.taskKey = taskKey;
    state.taskLoaded = false;
    state.taskEvents = [];
    state.taskState = null;
    renderTask();
    try {
      const tl = await fetchTaskTimeline(base, taskKey, { fetchImpl, timeoutMs });
      state.taskEvents = sortEntries(tl.events);
      state.taskState = tl.state;
      state.taskLoaded = true;
    } catch (e: any) {
      state.taskLoaded = true;
      state.taskEvents = [];
      const body = el('cx-task-body');
      if (body) {
        body.textContent = '';
        const li = doc.createElement('li');
        li.className = 'cx-empty';
        li.textContent = t('取时间线失败: ', 'timeline fetch failed: ') + String(e?.message || e).slice(0, 120);
        body.appendChild(li);
      }
      return;
    }
    renderTask();
  }

  function schedule(next: number) {
    if (state.disposed) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
      if (state.disposed) return;
      const ok = await refreshHeader();
      // 成功 → 常规轮询; 失败 → 指数退避 (1s/2s/4s…封顶 30s)
      schedule(ok ? pollMs : backoffDelayMs(state.failStreak - 1));
    }, next);
  }

  // ── 绑定 ─────────────────────────────────────────────────────────────────

  const more = el('cx-more');
  if (more) more.addEventListener('click', () => { void loadMore(); });

  const reload = el('cx-reload');
  if (reload) reload.addEventListener('click', () => { void refreshHeader(); void loadMore(); });

  const langBtn = el('cx-lang');
  if (langBtn) langBtn.addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    try { win.localStorage?.setItem('bolloon-lang', lang); } catch { /* noop */ }
    applyLang();
  });

  const form = el('cx-task-form');
  if (form) form.addEventListener('submit', (ev: any) => {
    ev?.preventDefault?.();
    const input: any = el('cx-task-input');
    const v = String(input?.value || '').trim().toLowerCase();
    // 用户粘进来的完整 taskKey 只用于取数, 取完立刻从输入框清掉 (页面上不保留完整值)
    if (input) input.value = '';
    if (!isTaskKey(v)) {
      const body = el('cx-task-body');
      if (body) {
        body.textContent = '';
        const li = doc.createElement('li');
        li.className = 'cx-empty';
        li.textContent = t('taskKey 必须是 0x + 64 位 hex', 'taskKey must be 0x + 64 hex');
        body.appendChild(li);
      }
      state.taskKey = null;
      return;
    }
    void openTask(v);
  });

  // prefers-reduced-motion: 关掉过渡/动画
  try {
    const mq = win.matchMedia?.('(prefers-reduced-motion: reduce)');
    const apply = () => root.classList.toggle('cx-reduce', !!mq?.matches);
    apply();
    mq?.addEventListener?.('change', apply);
  } catch { /* noop */ }

  applyLang();
  void (async () => {
    const ok = await refreshHeader();
    await loadMore();
    doc.documentElement?.setAttribute?.('data-cx-ready', '1');
    schedule(ok ? pollMs : backoffDelayMs(Math.max(0, state.failStreak - 1)));
  })();

  return () => {
    state.disposed = true;
    if (state.timer) clearTimeout(state.timer);
  };
}

// 浏览器里自动挂载 (node/vitest 里没有 document → 什么都不做)
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const boot = () => { try { mountChainExplorer({ win: window }); } catch (e) { console.error('[chain-explorer] 挂载失败', e); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
