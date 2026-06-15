/**
 * source-intent.ts — 行级 P2P 协作: 类型 + reserve.lock
 *
 * 为什么: 两台机上的智能体要协作维护同一份源码仓库, 粗粒度 task 协调不够
 * (同一文件不同行会冲突). 用行级 reserve 让 LLM 在改前先广播"我要改 X 行",
 * 对方看到重叠可让出/改方向/强制 merge.
 *
 * 数据流 (P2P RPC 消息, 走现有 P2PDirect.broadcast):
 *   reserve  →  我方申请改 file:[start,end]
 *   ack      →  对方也在这区间, 互相知道, 等 commit-intent 时看谁先到
 *   release  →  我方放弃 (LLM 决定改别的行)
 *   commit-intent → 我方 commit 后广播, 附 diffHash, 对方用 diffHash 验真伪
 *
 * 兜底:
 *   - TTL 5min, reserve 不 release 就过期
 *   - 200ms 等待 + 检冲突, 极端 race 双方都收到 conflict, LLM 自己重选
 *   - diffHash 不去判语义, 行级 merge 后 lefthook 失败 → revert
 */
import { EventEmitter } from 'events';

/** [start, end] 闭区间, 1-based, 含 start 和 end (跟 editor 一致) */
export type LineRange = readonly [number, number];

export interface ReserveMsg {
  type: 'reserve';
  taskId: string;          // 任务 uuid
  agent: string;           // 智能体身份 (e.g. "agent-A@mac1")
  file: string;            // 仓库内相对路径, e.g. "src/llm/foo.ts"
  lines: LineRange;
  /** 过期时间 epoch ms; 到期后 reserve.lock 自动清理 */
  expiresAt: number;
  ts: number;              // 发出时间, 用于调试/排序
}

export interface AckMsg {
  type: 'ack';
  taskId: string;
  agent: string;
  file: string;
  lines: LineRange;
  ts: number;
}

export interface ReleaseMsg {
  type: 'release';
  taskId: string;
  agent: string;
  file: string;
  lines: LineRange;
  ts: number;
}

export interface CommitIntentMsg {
  type: 'commit-intent';
  taskId: string;
  agent: string;
  file: string;
  lines: LineRange;
  sha: string;             // git commit SHA (短 7 位即可)
  diffHash: string;        // diff 内容 sha256 前 16 字符
  ts: number;
}

export type SourceIntentMsg =
  | ReserveMsg
  | AckMsg
  | ReleaseMsg
  | CommitIntentMsg;

/** 我方本地的 reserve 记录 (含 ttl) */
interface LocalReserve {
  taskId: string;
  agent: string;
  file: string;
  lines: LineRange;
  expiresAt: number;
  ts: number;
}

/**
 * 检测两个 LineRange 是否重叠.
 * 规则: 任一区间的一端落在对方区间内 → 重叠.
 * 不重叠示例: [1,5] vs [6,10] (边界相邻不算重叠).
 */
export function rangesOverlap(a: LineRange, b: LineRange): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * ReserveLock — 本地内存表, 记录"我方 + 远端"所有 live reserves.
 *
 * 事件:
 *   'added'    新增 reserve (我方或远端)
 *   'removed'  reserve 被释放 / 过期
 *   'conflict' 检测到重叠 (a,b)
 */
export class ReserveLock extends EventEmitter {
  /** key = `${file}:${start}-${end}` */
  private byKey: Map<string, LocalReserve> = new Map();
  /** TTL: 5 min, 兜底防止对方死掉/网络断后 reserve 永远不释放 */
  static readonly TTL_MS = 5 * 60 * 1000;

  /** 清理过期 reserve, 触发 'removed' 事件 */
  sweep(now: number = Date.now()): void {
    for (const [k, r] of this.byKey) {
      if (r.expiresAt <= now) {
        this.byKey.delete(k);
        this.emit('removed', r);
      }
    }
  }

  /** 我方/远端 reserve, 仅清自己区间后写入 (不清全表, 避免过期 reserve 干扰 add 测试) */
  add(r: LocalReserve): void {
    const key = keyOf(r.file, r.lines);
    const prev = this.byKey.get(key);
    this.byKey.set(key, r);
    if (prev) {
      // 同一区间已被对方 reserve, 我方再 reserve → 触发冲突
      this.emit('conflict', { a: prev, b: r });
    } else {
      this.emit('added', r);
    }
  }

  /** 释放指定 reserve (我方 LLM 决定让出时调用) */
  release(file: string, lines: LineRange): LocalReserve | null {
    const key = keyOf(file, lines);
    const r = this.byKey.get(key);
    if (!r) return null;
    this.byKey.delete(key);
    this.emit('removed', r);
    return r;
  }

  /** 查询某 (file, lines) 是否已被 reserve (含我方) */
  isReserved(file: string, lines: LineRange, now: number = Date.now()): LocalReserve | null {
    this.sweep(now);
    for (const r of this.byKey.values()) {
      if (r.file === file && rangesOverlap(r.lines, lines)) {
        return r;
      }
    }
    return null;
  }

  /** 取所有 live reserves (给 pi-ai 注入到系统 prompt) */
  live(now: number = Date.now()): LocalReserve[] {
    this.sweep(now);
    return [...this.byKey.values()];
  }

  /** 调试: dump 全部 */
  dump(): LocalReserve[] {
    return [...this.byKey.values()];
  }
}

function keyOf(file: string, lines: LineRange): string {
  return `${file}:${lines[0]}-${lines[1]}`;
}

/** 算 diffHash (git diff 的 sha256 前 16 字符) */
export function diffHashOf(diffText: string): string {
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.createHash('sha256').update(diffText, 'utf8').digest('hex').slice(0, 16);
}
