/**
 * chain-explorer.test.ts — P7 链上浏览器页面的单测
 * =========================================================================
 * 测两类东西 (都不需要真链/真浏览器, 真链 + 真 Chrome 的部分在
 * scripts/verify-chain-explorer.ts, 那里才做端到端断言):
 *   ① 纯函数: 短写(不泄露完整地址) / 排序 / cursor 分页合并 / 指数退避 /
 *      finality 三档 / 缺值不显示 0 / 双语空态文案
 *   ② 取数层的**降级语义**: 后端挂掉 → degraded + 全 null (绝不返回 0 当数字);
 *      请求超时由 AbortController 真触发
 *   ③ 静态页面纪律: src/web/explorer.html 与 src/web/chain-explorer.ts 里
 *      必须有的钩子 (aria-live / data-zh / data-en / cx-more / 降级横幅),
 *      以及**不得出现** innerHTML
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  shortHex, isFullAddress, isFullHash, summarizeArgs, argsText, renderEntryText,
  finalityOf, eventTone, compareEntries, sortEntries, cursorKey, mergeEntries,
  pageBoundaryIsExact, backoffDelayMs, finalityLabel, eventLabel, formatAgo, num,
  emptyTimelineText, noIndexText, fetchSnapshot, fetchPage, fetchTaskTimeline,
  DEFAULT_PAGE_LIMIT, BACKOFF_CAP_MS, type IndexEntry,
} from '../web/chain-explorer.js';

const ADDR = '0x' + 'ab'.repeat(20);
const HASH = '0x' + 'cd'.repeat(32);

const entry = (over: Partial<IndexEntry> = {}): IndexEntry => ({
  blockNumber: 100, blockHash: HASH, txHash: HASH, logIndex: 1, eventName: 'EscrowCreatedV2',
  args: { taskKey: HASH, buyer: ADDR, amount: '1000000' }, confirmations: 3, finality: 'confirmed',
  suspect: false, ...over,
});

describe('短写: 地址/哈希永不整条露出', () => {
  it('钱包地址 (20 字节) → 0x12ab…9f0e 形式', () => {
    expect(shortHex(ADDR)).toBe('0xabab…abab');
    expect(shortHex(ADDR)).not.toContain(ADDR);
  });

  it('32 字节哈希 (txHash/blockHash/taskKey) → 短写', () => {
    const s = shortHex(HASH);
    expect(s).toBe('0xcdcd…cdcd');
    expect(s.length).toBeLessThanOrEqual(12);
    expect(isFullHash(s)).toBe(false);
  });

  it('isFullAddress / isFullHash 只认整条', () => {
    expect(isFullAddress(ADDR)).toBe(true);
    expect(isFullAddress(shortHex(ADDR))).toBe(false);
    expect(isFullHash(HASH)).toBe(true);
    expect(isFullHash('0x1234')).toBe(false);
  });

  it('数字/短串原样返回, 超长非 hex 串截断', () => {
    expect(shortHex('1000000')).toBe('1000000');
    expect(shortHex('x'.repeat(40))).toBe('xxxxxxxxxxxx…xxxxxx');
  });

  it('argsText 与 renderEntryText 里都不含完整地址/哈希', () => {
    const e = entry();
    const line = renderEntryText(e);
    expect(line).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(line).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(line).toContain('taskKey=');
    expect(argsText(e.args)).toContain('amount=1000000');
  });

  it('args 关键字段优先排序 (taskKey/buyer/amount 在前)', () => {
    const keys = summarizeArgs({ zzz: '1', buyer: ADDR, taskKey: HASH, amount: '5' }).map((x) => x.key);
    expect(keys.slice(0, 3)).toEqual(['taskKey', 'buyer', 'amount']);
  });
});

describe('排序与 cursor 分页 (增量加载的正确性)', () => {
  it('按 (blockNumber, logIndex) 升序', () => {
    const list = sortEntries([
      entry({ blockNumber: 5, logIndex: 2 }), entry({ blockNumber: 5, logIndex: 0 }), entry({ blockNumber: 1, logIndex: 9 }),
    ]);
    expect(list.map((e) => `${e.blockNumber}:${e.logIndex}`)).toEqual(['1:9', '5:0', '5:2']);
    expect(compareEntries(list[0], list[1])).toBeLessThan(0);
  });

  it('cursorKey = blockNumber:logIndex', () => {
    expect(cursorKey({ blockNumber: 7, logIndex: 3 })).toBe('7:3');
  });

  it('mergeEntries 去重 (同一 cursor 只留一条) 且保持有序', () => {
    const a = entry({ blockNumber: 1, logIndex: 0 });
    const merged = mergeEntries([a], [entry({ blockNumber: 2, logIndex: 0 }), a]);
    expect(merged).toHaveLength(2);
    expect(merged.map(cursorKey)).toEqual(['1:0', '2:0']);
  });

  it('mergeEntries 丢掉脏数据 (没有 blockNumber 的不进列表)', () => {
    expect(mergeEntries([], [{ ...entry(), blockNumber: undefined as any }])).toHaveLength(0);
  });

  it('第 2 页必须严格在 cursor 之后 (无重叠/无遗漏)', () => {
    const p1 = { events: [entry({ blockNumber: 3, logIndex: 1 })], nextCursor: { blockNumber: 3, logIndex: 1 }, hasMore: true, remaining: 2 };
    const ok = { events: [entry({ blockNumber: 3, logIndex: 2 })], nextCursor: null as any, hasMore: false, remaining: 1 };
    const dup = { events: [entry({ blockNumber: 3, logIndex: 1 })], nextCursor: null as any, hasMore: false, remaining: 1 };
    const gap = { events: [entry({ blockNumber: 1, logIndex: 0 })], nextCursor: null as any, hasMore: false, remaining: 1 };
    expect(pageBoundaryIsExact(p1, ok)).toBe(true);
    expect(pageBoundaryIsExact(p1, dup)).toBe(false);
    expect(pageBoundaryIsExact(p1, gap)).toBe(false);
    expect(pageBoundaryIsExact({ ...p1, events: [] }, ok)).toBe(false);
  });
});

describe('退避与时间文案', () => {
  it('指数退避: 1s → 2s → 4s … 封顶 30s', () => {
    expect([0, 1, 2, 3, 4].map((n) => backoffDelayMs(n))).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(backoffDelayMs(10)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelayMs(-5)).toBe(1000);
    expect(backoffDelayMs(Number.NaN)).toBe(1000);
  });

  it('相对时间双语', () => {
    expect(formatAgo(5_000, 'zh')).toBe('5 秒前');
    expect(formatAgo(5_000, 'en')).toBe('5s ago');
    expect(formatAgo(120_000, 'zh')).toBe('2 分钟前');
    expect(formatAgo(7_200_000, 'en')).toBe('2h ago');
    expect(formatAgo(null, 'zh')).toBe('未知');
  });

  it('finality 三档文案 + 未知值不硬塞', () => {
    expect(finalityLabel('observed', 'zh')).toBe('观测中');
    expect(finalityLabel('confirmed', 'zh')).toBe('已确认');
    expect(finalityLabel('finalized', 'zh')).toBe('已最终');
    expect(finalityLabel('unknown', 'en')).toBe('unknown');
    expect(finalityOf({ finality: 'observed' })).toBe('observed');
    expect(finalityOf({ finality: 'confirmed' })).toBe('confirmed');
    expect(finalityOf({ finality: 'finalized' })).toBe('finalized');
    expect(finalityOf({ finality: 'wat' })).toBe('unknown');
    expect(finalityOf(null)).toBe('unknown');
  });

  it('事件分类与 stats 的分类一致', () => {
    expect(eventTone('EscrowCreatedV2')).toBe('created');
    expect(eventTone('ProofSubmittedV2')).toBe('proof');
    expect(eventTone('ReleasedV2')).toBe('released');
    expect(eventTone('RefundedV2')).toBe('refunded');
    expect(eventTone('DisputedV2')).toBe('disputed');
    expect(eventTone('ExpiredV2')).toBe('expired');
    expect(eventTone('SomethingElse')).toBe('other');
    expect(eventLabel('ReleasedV2', 'en')).toBe('released');
  });

  it('缺值显示 "—" 而不是 0', () => {
    expect(num(null)).toBe('—');
    expect(num(undefined)).toBe('—');
    expect(num(0)).toBe('0');
    expect(num(12)).toBe('12');
  });

  it('空态文案明说"索引里查不到", 不是"状态未知"', () => {
    expect(emptyTimelineText('0x1111…2222', 'zh')).toContain('从未出现');
    expect(emptyTimelineText('0x1111…2222', 'en')).toContain('never seen');
    expect(noIndexText('zh')).toContain('尚未同步');
  });
});

describe('取数层: 后端不可用 → 显式降级 (不编数字)', () => {
  const base = '';

  it('两个接口都 200 → live + 真数据', async () => {
    const fetchImpl = async (url: string) => ({
      ok: true, status: 200,
      json: async () => url.includes('/status')
        ? { ok: true, status: { lastSyncedBlock: 42, headBlock: 42, entries: 7 } }
        : { ok: true, stats: { entries: 7, tasks: 2, released: 1, byFinality: { observed: 0, confirmed: 1, finalized: 6 } } },
    });
    const snap = await fetchSnapshot(base, { fetchImpl });
    expect(snap.status).toBe('live');
    expect(snap.indexStatus?.lastSyncedBlock).toBe(42);
    expect(snap.stats?.byFinality?.finalized).toBe(6);
    expect(snap.error).toBeNull();
  });

  it('接口 500 → degraded 且 indexStatus/stats 都是 null', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const snap = await fetchSnapshot(base, { fetchImpl });
    expect(snap.status).toBe('degraded');
    expect(snap.indexStatus).toBeNull();
    expect(snap.stats).toBeNull();
    expect(snap.error).toContain('500');
  });

  it('网络不可达 (fetch 抛错) → degraded + 有原因', async () => {
    const snap = await fetchSnapshot('http://127.0.0.1:9', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(snap.status).toBe('degraded');
    expect(snap.error).toContain('ECONNREFUSED');
  });

  it('ok=false 也算降级 (不把错误当数据)', async () => {
    const snap = await fetchSnapshot(base, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: '坏了' }) }) });
    expect(snap.status).toBe('degraded');
    expect(snap.stats).toBeNull();
  });

  it('请求超时: AbortController 真发出 abort, 不无限等', async () => {
    let aborted = false;
    const fetchImpl = (_url: string, init: any) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); });
    });
    const t0 = Date.now();
    const snap = await fetchSnapshot(base, { fetchImpl, timeoutMs: 60 });
    expect(aborted).toBe(true);
    expect(snap.status).toBe('degraded');
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('fetchPage 把 cursor 与 limit 传进查询串 (按 cursor 取下一段, 不整页重拉)', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ ok: true, page: { events: [{ ...entry(), blockNumber: 9, logIndex: 2 }], nextCursor: { blockNumber: 9, logIndex: 2 }, hasMore: false, remaining: 1 } }) };
    };
    const page = await fetchPage(base, { blockNumber: 4, logIndex: 1 }, { limit: 7, fetchImpl });
    expect(seen[0]).toContain('/api/chain/index/events?');
    expect(seen[0]).toContain('blockNumber=4');
    expect(seen[0]).toContain('logIndex=1');
    expect(seen[0]).toContain('limit=7');
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor?.blockNumber).toBe(9);

    const first = await fetchPage(base, null, { fetchImpl });
    expect(seen[1]).not.toContain('blockNumber=');
    expect(seen[1]).toContain(`limit=${DEFAULT_PAGE_LIMIT}`);
    expect(first.hasMore).toBe(false);
  });

  it('fetchTaskTimeline: 未知 taskKey 返回空 (不编造)', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, timeline: { taskKey: HASH, state: null, events: [], count: 0, hasSuspect: false } }) });
    const tl = await fetchTaskTimeline(base, HASH, { fetchImpl });
    expect(tl.count).toBe(0);
    expect(tl.events).toEqual([]);
    expect(tl.state).toBeNull();
  });

  it('fetchTaskTimeline 的 taskKey 参数被 URL 编码', async () => {
    let url = '';
    const fetchImpl = async (u: string) => { url = u; return { ok: true, status: 200, json: async () => ({ ok: true, timeline: { taskKey: HASH, state: 'ACTIVE', events: [], count: 0, hasSuspect: false } }) }; };
    await fetchTaskTimeline(base, HASH, { fetchImpl });
    expect(url).toContain(`taskKey=${encodeURIComponent(HASH)}`);
  });
});

describe('页面前端纪律 (对着源文件核)', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'web', 'explorer.html'), 'utf8');
  const ts = fs.readFileSync(path.join(root, 'web', 'chain-explorer.ts'), 'utf8');

  it('活动文本只用 textContent —— 源码里没有 innerHTML 用法', () => {
    // 注释里可以提到这个词 (说明纪律), 但**代码**里不得出现使用: .innerHTML / innerHTML =
    expect(ts).not.toMatch(/\.innerHTML/);
    expect(ts).not.toMatch(/innerHTML\s*=/);
    expect(html).not.toMatch(/\.innerHTML\s*=/);
  });

  it('双语 data-zh / data-en 成对出现', () => {
    const zh = (html.match(/data-zh=/g) || []).length;
    const en = (html.match(/data-en=/g) || []).length;
    expect(zh).toBe(en);
    expect(zh).toBeGreaterThanOrEqual(15);
  });

  it('状态区带 aria-live', () => {
    expect(html).toMatch(/aria-live="polite"/);
    expect(html).toContain('id="cx-state"');
  });

  it('关键钩子齐全 (高度/统计/统计分类/finality 三档/时间线/加载更多/taskKey 查询/降级横幅)', () => {
    for (const id of ['chain-explorer-root', 'cx-height', 'cx-lastsync', 'cx-entries', 'cx-tasks', 'cx-created',
      'cx-proof', 'cx-released', 'cx-refunded', 'cx-disputed', 'cx-expired', 'cx-final-observed',
      'cx-final-confirmed', 'cx-final-finalized', 'cx-timeline-body', 'cx-more', 'cx-task-form',
      'cx-task-body', 'cx-degraded', 'cx-task-input']) {
      expect(html, `缺钩子 #${id}`).toContain(`id="${id}"`);
    }
  });

  it('尊重 prefers-reduced-motion (样式 + 运行时开关都在)', () => {
    expect(html).toContain('prefers-reduced-motion');
    expect(ts).toContain('prefers-reduced-motion');
    expect(ts).toContain('cx-reduce');
  });

  it('轮询 / 超时 / 指数退避 / 短写在源码里都在', () => {
    expect(ts).toContain('POLL_INTERVAL_MS');
    expect(ts).toContain('AbortController');
    expect(ts).toContain('backoffDelayMs');
    expect(ts).toContain('…');
  });

  it('页面加载编译产物 (禁手改 dist: 源是 .ts, 产物名 chain-explorer.js)', () => {
    expect(html).toContain('chain-explorer.js');
  });

  it('页面里没有把完整 taskKey 塞进 DOM 属性的写法', () => {
    expect(ts).not.toMatch(/setAttribute\(\s*['"]data-taskkey['"]/);
    expect(ts).toContain('data-idx');
  });

  it('降级文案写清"不给 0 顶替"', () => {
    expect(html).toContain('后端不可用');
    expect(html).toMatch(/0 顶替|never substitute 0/);
  });
});
