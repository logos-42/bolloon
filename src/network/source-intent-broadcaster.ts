/**
 * source-intent-broadcaster.ts — 包装 P2PDirect, 收发 SourceIntentMsg
 *
 * 用法:
 *   const p2p = new P2PDirect({ name: 'bolloon', role: 'source-agent' });
 *   await p2p.start();
 *   const sb = new SourceIntentBroadcaster(p2p, { agent: 'agent-A@mac1' });
 *   await sb.start();
 *
 *   // 我方要改 src/foo.ts 行 42-50
 *   const conflict = await sb.reserve({ taskId, file: 'src/foo.ts', lines: [42, 50] });
 *   if (conflict) {
 *     // 对方已 reserve, 选: 让出 / 改别的 / 强制
 *   } else {
 *     sb.writeFileAndCommit(...);
 *     await sb.broadcastCommitIntent({ taskId, file, lines, sha, diffHash });
 *   }
 *
 * 主题: 复用现有 'bolloon-agent-harness' topic (P2PDirect 已 join),
 *       上层加 'source-intent:' 前缀避免和别的协议混.
 */
import { EventEmitter } from 'events';
import { P2PDirect } from './p2p-direct.js';
import {
  ReserveLock,
  SourceIntentMsg,
  ReserveMsg,
  AckMsg,
  ReleaseMsg,
  CommitIntentMsg,
  LineRange,
  rangesOverlap,
} from './source-intent.js';

export interface BroadcasterOptions {
  agent: string;       // 智能体身份
  topic?: string;      // P2P 主题, 默认复用 'bolloon-agent-harness'
  waitMs?: number;     // reserve 等待 ack 多久, 默认 200ms
}

export class SourceIntentBroadcaster extends EventEmitter {
  readonly p2p: P2PDirect;
  readonly agent: string;
  readonly topic: string;
  readonly waitMs: number;
  readonly lock = new ReserveLock();

  private started = false;
  private dataHandler: ((data: Buffer, from: string) => void) | null = null;

  constructor(p2p: P2PDirect, opts: BroadcasterOptions) {
    super();
    this.p2p = p2p;
    this.agent = opts.agent;
    this.topic = opts.topic || 'bolloon-agent-harness';
    this.waitMs = opts.waitMs ?? 200;
  }

  async start(): Promise<void> {
    if (this.started) return;
    // 确保 p2p 已 join topic
    await this.p2p.joinTopic(this.topic);

    this.dataHandler = (data: Buffer, from: string) => {
      try {
        const text = data.toString('utf8');
        // 协议前缀 'source-intent:'
        if (!text.startsWith('source-intent:')) return;
        const json = text.slice('source-intent:'.length);
        const msg = JSON.parse(json) as SourceIntentMsg;
        this.onMessage(msg, from);
      } catch (err) {
        // 静默忽略非本协议消息
      }
    };
    this.p2p.on('data', this.dataHandler);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    if (this.dataHandler) this.p2p.off('data', this.dataHandler);
    this.started = false;
  }

  /**
   * 申请 reserve (file, lines).
   * 返回 {ok:true} → 成功 (没有重叠)
   * 返回 {ok:false, existing} → 本地 lock 已有重叠, LLM 决定让出 / 改方向 / 强制
   */
  async reserve(args: {
    taskId: string;
    file: string;
    lines: LineRange;
  }): Promise<{ ok: true } | { ok: false; existing: { agent: string; lines: LineRange } }> {
    const now = Date.now();
    const msg: ReserveMsg = {
      type: 'reserve',
      taskId: args.taskId,
      agent: this.agent,
      file: args.file,
      lines: args.lines,
      expiresAt: now + ReserveLock.TTL_MS,
      ts: now,
    };

    // 1. 先查本地 lock: 本端/远端任何 reserve 重叠都立即冲突 (避免 [5,15] 漏检 [1,10])
    const existing = this.lock.isReserved(args.file, args.lines);
    if (existing) {
      return { ok: false, existing: { agent: existing.agent, lines: existing.lines } };
    }

    // 2. 写本地 lock
    this.lock.add({
      taskId: msg.taskId,
      agent: msg.agent,
      file: msg.file,
      lines: msg.lines,
      expiresAt: msg.expiresAt,
      ts: msg.ts,
    });

    // 3. 广播
    this.broadcastMsg(msg);

    // 4. 等待 waitMs 看远端是否 ack 同一区间
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('remoteConflict', onRemote);
        resolve({ ok: true });
      }, this.waitMs);

      const onRemote = (existing: { agent: string; lines: LineRange }) => {
        clearTimeout(timer);
        resolve({ ok: false, existing });
      };
      this.once('remoteConflict', onRemote);
    });
  }

  /** 释放我方 reserve */
  release(args: { taskId: string; file: string; lines: LineRange }): void {
    const msg: ReleaseMsg = {
      type: 'release',
      taskId: args.taskId,
      agent: this.agent,
      file: args.file,
      lines: args.lines,
      ts: Date.now(),
    };
    this.lock.release(args.file, args.lines);
    this.broadcastMsg(msg);
  }

  /** commit 后广播, 供对方做轻量审计 (diffHash 验真伪) */
  async broadcastCommitIntent(args: {
    taskId: string;
    file: string;
    lines: LineRange;
    sha: string;
    diffHash: string;
  }): Promise<void> {
    const msg: CommitIntentMsg = {
      type: 'commit-intent',
      taskId: args.taskId,
      agent: this.agent,
      file: args.file,
      lines: args.lines,
      sha: args.sha,
      diffHash: args.diffHash,
      ts: Date.now(),
    };
    this.broadcastMsg(msg);
  }

  /** 取所有 live reserves (给 pi-ai 注入到 LLM 系统 prompt) */
  liveReserves() {
    return this.lock.live();
  }

  // ---- 内部 ----

  private broadcastMsg(msg: SourceIntentMsg): void {
    const text = 'source-intent:' + JSON.stringify(msg);
    this.p2p.broadcast(Buffer.from(text, 'utf8'));
  }

  private onMessage(msg: SourceIntentMsg, from: string): void {
    // 忽略自己发出的消息 (P2PDirect 自身会发到自己的 loopback)
    if (msg.agent === this.agent) return;

    switch (msg.type) {
      case 'reserve': {
        // 检查本地是否已 reserve 重叠区间
        const existing = this.lock.isReserved(msg.file, msg.lines);
        if (existing) {
          // 我方有重叠, 对方也 reserve → 触发 conflict
          this.emit('remoteConflict', { agent: msg.agent, lines: msg.lines });
          // 自己也回一个 ack 让对方知道我方已 reserve
          const ack: AckMsg = {
            type: 'ack',
            taskId: existing.taskId,
            agent: this.agent,
            file: existing.file,
            lines: existing.lines,
            ts: Date.now(),
          };
          this.broadcastMsg(ack);
        }
        // 记入 lock (远端的 reserve 我方也要避开, LLM 看 prompt 知道)
        this.lock.add({
          taskId: msg.taskId,
          agent: msg.agent,
          file: msg.file,
          lines: msg.lines,
          expiresAt: msg.expiresAt,
          ts: msg.ts,
        });
        this.emit('remoteReserve', msg);
        break;
      }
      case 'ack': {
        // 远端 ack 我方已 reserve 同一区间 → 立即触发 conflict
        const local = this.lock.isReserved(msg.file, msg.lines);
        if (local) {
          this.emit('remoteConflict', { agent: msg.agent, lines: msg.lines });
        }
        break;
      }
      case 'release': {
        this.lock.release(msg.file, msg.lines);
        this.emit('remoteRelease', msg);
        break;
      }
      case 'commit-intent': {
        this.lock.release(msg.file, msg.lines);
        this.emit('remoteCommit', msg);
        break;
      }
    }
  }
}
