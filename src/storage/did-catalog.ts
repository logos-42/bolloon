/**
 * did-catalog.ts — 以用户 DID 为唯一标识的 Postgres 式关系目录 (2026-08-08)
 *
 * 借鉴 Postgres 标准设计:
 *   - 表 (table) 由列 (columns) 定义, 每个表有主键 (dsc_key, 默认 = row 的 id 字段)
 *   - 每张表 + 每行都以主键 did 分区: 同一用户的全部数据通过 userDid 绑定
 *   - 变更写入日志 (WAL: append-only event log), 与目录一起落盘
 *   - 多设备同步 = 拉取另一台设备的 WAL → 回放 (replay) → 按 updatedAt LWW 合并
 *
 * 数据模型 (Postgres 式 DDL):
 *   TABLE memory   (did, dsc_key, content, meta, updatedAt, deviceId)
 *   TABLE vocal     (did, agentId, persona/name, did, publicKey...)
 *   TABLE on_policy (did, policyVersion, policy(JSON), updatedAt)
 *   TABLE skills   ...
 *   TABLE tools / plugins / mcp / context_os ...
 *
 * WAL 事件谱:
 *   { seq, did, table, op: upsert|delete, key, dscid, row, ts, deviceId }
 * 回放/合并规则: 同 (did,table,dscid) → 取 updatedAt 较大者 (LWW); 更新更大的 `rev`
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export type DscTable =
  | 'memory'
  | 'persona'
  | 'on_policy'
  | 'skills'
  | 'tools'
  | 'plugins'
  | 'mcp'
  | 'context_os'
  | 'channels';

export const ALL_TABLES: DscTable[] = [
  'memory', 'persona', 'on_policy', 'skills', 'tools', 'plugins', 'mcp', 'context_os', 'channels',
];

/** WAL 事件: 一次写操作 */
export interface DscWalEvent {
  seq: number;
  did: string;
  table: DscTable;
  op: 'upsert' | 'delete';
  key: string;
  row: Record<string, unknown> | null;
  ts: number;
  deviceId: string;
}

/** 一行目录数据 (Postgres 式) */
export interface DscRow {
  /** 行级主键 (表内唯一) */
  dscKey: string;
  /** 开放列 (content/meta...) */
  data: Record<string, unknown>;
  updatedAt: number;
  deviceId: string;
}

export interface DidCatalogOptions {
  /** ~/.bolloon */
  home?: string;
  /** 设备标识 (多设备同步靠它区分来源) */
  deviceId?: string;
}

const homeDir = (h?: string): string => {
  if (h) return h;
  return process.env.HOME || os.homedir() || '/tmp';
};

/** 安全 DID → 目录名片段 */
export function didDirName(did: string): string {
  return did.split(':').pop()?.substring(0, 24) || 'unknown';
}

export interface DidOpenOptions {
  /** ~/.bolloon */
  home?: string;
  /** 设备标识 (多设备同步靠它区分来源) */
  deviceId?: string;
}

export class DidCatalog {
  readonly did: string;
  readonly deviceId: string;
  private root: string;
  private tables: Record<string, Map<string, DscRow>> = {};
  private wal: DscWalEvent[] = [];
  private nextSeq = 0;
  private dirty = false;

  constructor(did: string, opts: DidOpenOptions = {}) {
    this.did = did;
    this.deviceId = opts.deviceId || 'device1';
    const base = path.join(homeDir(opts.home), '.bolloon', 'did-catalog');
    // 以 did 分区: ~/.bolloon/did-catalog/<did>/table.json + wal.jsonl
    this.root = path.join(base, didDirName(did));
    for (const t of ALL_TABLES) this.tables[t] = new Map();
  }

  get rootPath(): string { return this.root; }

  private tablePath(t: DscTable): string { return path.join(this.root, `${t}.json`); }
  private walPath(): string { return path.join(this.root, 'wal.jsonl'); }

  /** 加载本地持久化 (表 + WAL)。幂等, 可重复调。 */
  async load(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    for (const t of ALL_TABLES) {
      try {
        const raw = JSON.parse(await fs.readFile(this.tablePath(t), 'utf-8')) as Record<string, DscRow>;
        this.tables[t] = new Map(Object.entries(raw));
      } catch { this.tables[t] = new Map(); }
    }
    // WAL 回放自身劫
    this.wal = [];
    try {
      const text = await fs.readFile(this.walPath(), 'utf-8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as DscWalEvent;
          this.wal.push(e);
          if (e.seq >= this.nextSeq) this.nextSeq = e.seq + 1;
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 无 WAL */ }
  }

  /** 无参 upsert / write-return. @param keys -> 主键自动填 */
  async upsert(table: DscTable, key: string, data: Record<string, unknown>): Promise<DscWalEvent> {
    const now = Date.now();
    const existing = this.tables[table]?.get(key);
    const ev: DscWalEvent = {
      seq: this.nextSeq++,
      did: this.did,
      table,
      op: 'upsert',
      key,
      row: { ...existing?.data, ...data, dscKey: key, updatedAt: now, deviceId: this.deviceId },
      ts: now,
      deviceId: this.deviceId,
    };
    this.tables[table].set(key, {
      dscKey: key,
      data: ev.row as Record<string, unknown>,
      updatedAt: now,
      deviceId: this.deviceId,
    });
    this.wal.push(ev);
    this.dirty = true;
    return ev;
  }

  /** 删除一行 */
  async remove(table: DscTable, key: string): Promise<DscWalEvent | null> {
    if (!this.tables[table]?.has(key)) return null;
    const ev: DscWalEvent = {
      seq: this.nextSeq++, did: this.did, table, op: 'delete', key,
      row: null, ts: Date.now(), deviceId: this.deviceId,
    };
    this.tables[table].delete(key);
    this.wal.push(ev);
    this.dirty = true;
    return ev;
  }

  /** 读一行 */
  get(table: DscTable, key: string): DscRow | undefined {
    return this.tables[table]?.get(key);
  }

  /** 全表 */
  all(table: DscTable): Array<{ key: string; row: DscRow }> {
    return Array.from((this.tables[table] || new Map()).entries()).map(([k, r]) => ({ key: k, row: r }));
  }

  /** 基础查询: 按字段精确匹配 (Postgres WHERE col = v) */
  where(table: DscTable, col: string, value: unknown): DscRow[] {
    return this.all(table).filter(({ row }) => {
      const v = (row.data as Record<string, unknown>)[col];
      return String(v) === String(value);
    }).map(({ row }) => row);
  }

  get walEvents(): DscWalEvent[] { return Array.from(this.wal); }

  /**
   * 多设备同步入口: 接收一台设备的 WAL 事件流, 按 updatedAt LWW 合并.
   * 返回 {applied, merged} — applied=本机新增, merged=LWW 冲突保留较大者.
   */
  syncRemote(events: DscWalEvent[]): { applied: number; merged: number } {
    const byKey = new Map<string, DscWalEvent>();
    for (const e of events) {
      if (!e.table || !e.key) continue;
      if (e.did && e.did !== this.did) continue; // 只收本用户 DID 的数据
      const signature = `${e.table}::${e.key}`;
      if (e.op === 'delete') { byKey.set(signature, e); continue; }
      const prior = byKey.get(signature);
      if (!prior || (e.ts ?? 0) >= (prior.ts ?? 0)) byKey.set(signature, e);
    }
    let applied = 0, merged = 0;
    for (const e of byKey.values()) {
      if (e.op === 'delete') {
        const had = this.tables[e.table]?.has(e.key);
        if (had) { this.tables[e.table]?.delete(e.key); applied++; }
        continue;
      }
      const cur = this.tables[e.table]?.get(e.key);
      if (cur && (cur.updatedAt ?? 0) > (e.ts ?? 0)) { merged++; continue; } // 本地更新 → 保留本地
      this.tables[e.table]?.set(e.key, {
        dscKey: e.key,
        data: e.row as Record<string, unknown>,
        updatedAt: e.ts ?? Date.now(),
        deviceId: e.deviceId || 'remote',
      });
      applied++;
    }
    this.dirty = true;
    return { applied, merged };
  }

  /** 持久化表 + WAL 到磁盘 */
  async persist(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    for (const t of ALL_TABLES) {
      const obj: Record<string, DscRow> = {};
      for (const [k, r] of this.tables[t]) obj[k] = r;
      await fs.writeFile(this.tablePath(t), JSON.stringify(obj, null, 2), 'utf-8');
    }
    const lines = this.wal.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(this.walPath(), lines, 'utf-8');
    this.dirty = false;
  }

  get isDirty(): boolean { return this.dirty; }
}

interface CatalogRegistry {
  open(did: string, opts?: DidOpenOptions): Promise<DidCatalog>;
  /** 持久化缓存过的目录 */
  persistAll(): Promise<void>;
}

/** 轻量单例注册: 同 DID 复用同一目录实例 (跨模块共享) */
export function createDidCatalogRegistry(opts: DidOpenOptions = {}): CatalogRegistry {
  const cache = new Map<string, Promise<DidCatalog>>();
  return {
    async open(did) {
      if (!did) throw new Error('did 必填');
      if (!cache.has(did)) {
        cache.set(did, (async () => {
          const c = new DidCatalog(did, opts);
          await c.load();
          return c;
        })());
      }
      return cache.get(did)!;
    },
    async persistAll() {
      for (const p of cache.values()) { const c = await p; if (c.isDirty) await c.persist(); }
    },
  };
}

export type { CatalogRegistry };

/** 进程级默认注册表 (server / CLI 共用, 同 DID 复用实例) */
const _defaultRegistry = createDidCatalogRegistry();
/** 按 did 打开的目录 (默认注册表单例) — 供各端点快速接入 */
export async function registryOpen(did: string, opts?: DidOpenOptions): Promise<DidCatalog> {
  const reg = opts ? createDidCatalogRegistry(opts) : _defaultRegistry;
  return reg.open(did);
}