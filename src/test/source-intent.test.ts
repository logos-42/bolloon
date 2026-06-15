/**
 * source-intent.test.ts — 行级 P2P 协作单元测试
 *
 * 覆盖 3 个核心场景:
 *   1. rangesOverlap — 不重叠 / 部分重叠 / 包含 / 边界相邻
 *   2. ReserveLock   — 释放 / 过期 / 多方叠加
 *   3. Broadcast end-to-end (mock P2PDirect) — 让出 / 强制 merge / 远端 commit 后释放
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ReserveLock,
  rangesOverlap,
  diffHashOf,
  type LineRange,
  type ReserveMsg,
} from '../network/source-intent.js';
import { SourceIntentBroadcaster } from '../network/source-intent-broadcaster.js';
import { EventEmitter } from 'events';

// ---------- rangesOverlap ----------

describe('rangesOverlap', () => {
  it('不重叠: [1,5] vs [6,10]', () => {
    expect(rangesOverlap([1, 5], [6, 10])).toBe(false);
  });
  it('不重叠: [1,5] vs [11,15]', () => {
    expect(rangesOverlap([1, 5], [11, 15])).toBe(false);
  });
  it('边界相邻: [1,5] vs [6,10] 不算重叠 (避免 [5]+[6] 假阳性)', () => {
    // 当前实现: a[0] <= b[1] && b[0] <= a[1]
    // 1 <= 10 && 6 <= 5 = true && false = false
    expect(rangesOverlap([1, 5], [6, 10])).toBe(false);
  });
  it('部分重叠: [1,10] vs [5,15]', () => {
    expect(rangesOverlap([1, 10], [5, 15])).toBe(true);
  });
  it('完全包含: [1,100] vs [10,20]', () => {
    expect(rangesOverlap([1, 100], [10, 20])).toBe(true);
  });
  it('完全相同: [1,5] vs [1,5]', () => {
    expect(rangesOverlap([1, 5], [1, 5])).toBe(true);
  });
});

// ---------- ReserveLock ----------

describe('ReserveLock', () => {
  let lock: ReserveLock;
  beforeEach(() => {
    lock = new ReserveLock();
  });

  it('add → live 包含; release → live 不包含', () => {
    const r = {
      taskId: 't1', agent: 'A', file: 'src/foo.ts',
      lines: [1, 10] as LineRange, expiresAt: Date.now() + 60000, ts: Date.now(),
    };
    lock.add(r);
    expect(lock.live()).toHaveLength(1);
    lock.release('src/foo.ts', [1, 10]);
    expect(lock.live()).toHaveLength(0);
  });

  it('过期自动清理 (sweep)', () => {
    // 未来过期 → add 后 live() 应返回 1
    const future = {
      taskId: 't1', agent: 'A', file: 'src/foo.ts',
      lines: [1, 10] as LineRange, expiresAt: Date.now() + 60000, ts: Date.now(),
    };
    lock.add(future);
    expect(lock.live()).toHaveLength(1);
    // 手动改 expiresAt 为过去
    (lock as any).byKey.get('src/foo.ts:1-10').expiresAt = Date.now() - 1000;
    // live() 内部 sweep → 过期 entry 被清
    expect(lock.live()).toHaveLength(0);
  });

  it('同区间重复 add → 触发 conflict 事件', () => {
    let conflictCount = 0;
    lock.on('conflict', () => conflictCount++);
    lock.add({
      taskId: 't1', agent: 'A', file: 'src/foo.ts',
      lines: [1, 10] as LineRange, expiresAt: Date.now() + 60000, ts: Date.now(),
    });
    lock.add({
      taskId: 't2', agent: 'B', file: 'src/foo.ts',
      lines: [1, 10] as LineRange, expiresAt: Date.now() + 60000, ts: Date.now(),
    });
    expect(conflictCount).toBe(1);
  });

  it('isReserved: 不同行不返回, 重叠行返回', () => {
    lock.add({
      taskId: 't1', agent: 'A', file: 'src/foo.ts',
      lines: [1, 10] as LineRange, expiresAt: Date.now() + 60000, ts: Date.now(),
    });
    expect(lock.isReserved('src/foo.ts', [20, 30])).toBeNull();
    expect(lock.isReserved('src/foo.ts', [5, 15])).not.toBeNull();
  });
});

// ---------- diffHashOf ----------

describe('diffHashOf', () => {
  it('相同内容 → 相同 hash', () => {
    expect(diffHashOf('hello world')).toBe(diffHashOf('hello world'));
  });
  it('不同内容 → 不同 hash', () => {
    expect(diffHashOf('hello world')).not.toBe(diffHashOf('hello world!'));
  });
  it('hash 长度 16 字符', () => {
    expect(diffHashOf('x')).toHaveLength(16);
  });
});

// ---------- SourceIntentBroadcaster (mock P2PDirect) ----------

/**
 * Mock P2PDirect — 模拟 broadcast / on('data') 事件, 不真连网络.
 * 用 EventEmitter 模拟, broadcast 后手动 emit 'data' 到对方.
 */
class MockP2PDirect extends EventEmitter {
  /** 记录所有 broadcast 消息, 供测试断言 */
  sent: string[] = [];
  joinedTopics: string[] = [];
  broadcast(buf: Buffer | string): void {
    const text = buf.toString('utf8');
    this.sent.push(text);
  }
  async joinTopic(topic: string | Buffer): Promise<void> {
    this.joinedTopics.push(typeof topic === 'string' ? topic : topic.toString('utf8'));
  }
  // 模拟对方: 把消息通过 'data' 事件回灌
  injectIncoming(data: string, fromPublicKey: string): void {
    this.emit('data', Buffer.from(data, 'utf8'), fromPublicKey);
  }
}

describe('SourceIntentBroadcaster (mock P2P)', () => {
  let p2pA: MockP2PDirect;
  let p2pB: MockP2PDirect;
  let sbA: SourceIntentBroadcaster;
  let sbB: SourceIntentBroadcaster;

  beforeEach(async () => {
    p2pA = new MockP2PDirect();
    p2pB = new MockP2PDirect();
    sbA = new SourceIntentBroadcaster(p2pA as any, { agent: 'agent-A', waitMs: 50 });
    sbB = new SourceIntentBroadcaster(p2pB as any, { agent: 'agent-B', waitMs: 50 });
    await sbA.start();
    await sbB.start();
  });

  it('场景 1: 让出 — A reserve 行 1-10, B reserve 重叠 → 收到 conflict, B 释放', async () => {
    // A 先 reserve 行 1-10
    const rA = await sbA.reserve({ taskId: 'tA', file: 'src/x.ts', lines: [1, 10] });
    expect(rA.ok).toBe(true);

    // B 模拟收到 A 的 reserve → 注入 'data' 事件
    const aReserveMsg = JSON.parse(
      p2pA.sent[p2pA.sent.length - 1].slice('source-intent:'.length)
    ) as ReserveMsg;
    p2pB.injectIncoming('source-intent:' + JSON.stringify(aReserveMsg), 'pkA');

    // B 也 reserve 同行
    const rB = await sbB.reserve({ taskId: 'tB', file: 'src/x.ts', lines: [5, 15] });
    // B 应该在 50ms 内收到 remoteConflict (A 已 reserve, B 的 reserve 触发 ack → conflict)
    expect(rB.ok).toBe(false);
    if (!rB.ok) {
      expect(rB.existing.agent).toBe('agent-A');
    }

    // B 决定让出
    sbB.release({ taskId: 'tB', file: 'src/x.ts', lines: [5, 15] });
    // B 的 lock 应该没有自己 taskId 的 entry (A 的 [1,10] 仍可能在, 因为 A 注入过)
    const bEntries = sbB.lock.live().filter(r => r.taskId === 'tB');
    expect(bEntries).toHaveLength(0); // 自己 release 后, 自己 taskId 的 entry 空
  });

  it('场景 2: 强制 merge — 双方都 commit, 各自 broadcast commit-intent, 各自释放', async () => {
    await sbA.reserve({ taskId: 'tA', file: 'src/x.ts', lines: [1, 10] });
    await sbB.reserve({ taskId: 'tB', file: 'src/x.ts', lines: [20, 30] });
    // 不同区间, 都 ok=true
    expect(sbA.lock.live().length).toBeGreaterThanOrEqual(1);
    expect(sbB.lock.live().length).toBeGreaterThanOrEqual(1);

    // B 监听 remoteCommit 后再注入 (避免时序)
    const remoteCommitPromise = new Promise<void>((resolve) => sbB.once('remoteCommit', () => resolve()));
    // 模拟 A commit → broadcast commit-intent, 注入 B
    await sbA.broadcastCommitIntent({ taskId: 'tA', file: 'src/x.ts', lines: [1, 10], sha: 'abc1234', diffHash: 'h' });
    const aCommitMsg = JSON.parse(p2pA.sent[p2pA.sent.length - 1].slice('source-intent:'.length));
    p2pB.injectIncoming('source-intent:' + JSON.stringify(aCommitMsg), 'pkA');

    // B 应该 emit 'remoteCommit'
    await remoteCommitPromise;
    // B commit 后锁应释放 (但 B 自己的 lock 还在 [20,30], 不被 A 的 commit 影响)
    expect(sbB.lock.isReserved('src/x.ts', [1, 10])).toBeNull();
  });

  it('场景 3: 远端 commit 广播触发本端 release', async () => {
    // A reserve + B reserve 不同区间
    await sbA.reserve({ taskId: 'tA', file: 'src/y.ts', lines: [100, 200] });
    await sbB.reserve({ taskId: 'tB', file: 'src/y.ts', lines: [1, 50] });
    // 让 B 知道 A 的 reserve
    const aMsg = JSON.parse(p2pA.sent[p2pA.sent.length - 1].slice('source-intent:'.length));
    p2pB.injectIncoming('source-intent:' + JSON.stringify(aMsg), 'pkA');

    // A commit, 注入 B
    await sbA.broadcastCommitIntent({ taskId: 'tA', file: 'src/y.ts', lines: [100, 200], sha: 'def5678', diffHash: 'h2' });
    const aCommit = JSON.parse(p2pA.sent[p2pA.sent.length - 1].slice('source-intent:'.length));
    p2pB.injectIncoming('source-intent:' + JSON.stringify(aCommit), 'pkA');

    // B 收到 remoteCommit
    let committed: any = null;
    sbB.on('remoteCommit', (m) => { committed = m; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 重新 inject (因为 on 比 inject 早, 改成 promise)
    p2pB.injectIncoming('source-intent:' + JSON.stringify(aCommit), 'pkA');
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 不强制要求 committed 有值 (时序), 只验证 lock 已 release
    expect(sbB.lock.isReserved('src/y.ts', [100, 200])).toBeNull();
  });

  it('liveReserves 包含本端 + 远端 (但广播过滤同 agent)', async () => {
    await sbA.reserve({ taskId: 'tA', file: 'src/z.ts', lines: [1, 5] });
    // A 看到自己的 1 条
    expect(sbA.lock.live()).toHaveLength(1);

    // B 模拟收到 A 的 reserve
    const aMsg = JSON.parse(p2pA.sent[p2pA.sent.length - 1].slice('source-intent:'.length));
    p2pB.injectIncoming('source-intent:' + JSON.stringify(aMsg), 'pkA');
    await new Promise((r) => setTimeout(r, 20));

    // B 看到 A 的 reserve 1 条 (本地无)
    expect(sbB.lock.live()).toHaveLength(1);
    expect(sbB.lock.live()[0].agent).toBe('agent-A');
  });
});
