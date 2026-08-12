/**
 * task-store.ts — Task 队列的 OrbitDB 主存储 (2026-08-12, Task6)
 *
 * 把 hermes kanban 用 OrbitDB 实现: 任务队列以 OrbitDB keyvalue store 为主存储,
 * 支持跨设备/去中心化同步 (与 did-catalog-replication 同模式, 共享同一 helia 节点).
 *
 * 设计:
 *   - store 名: `bolloon-tasks-<did短名>` (确定性, 跨设备同名 → 同一复制流)
 *   - 存整个任务数组到单键 `tasks` (兼容 server-storage 现有 loadTaskQueue/saveTaskQueue)
 *   - 懒初始化 + 幂等: 首次 warm 时打开 store; 失败静默 → 回退本地文件 (增强层, 不阻塞)
 *   - 生产由 server 启动时 warmTaskOrbitStore() 预热; 测试环境 (临时 HOME) 不预热 → 走本地
 *
 * 失败静默: OrbitDB 不可用 (离线/首次/测试) 时任务照常走本地文件, 不阻塞主路径.
 */

import * as path from 'path';
import * as os from 'os';
import { getCIDDatabase, type CIDDatabase, type OrbitDBStore } from './cid-database.js';

const homeRoot = (): string => process.env.HOME || os.homedir() || '/tmp';

export const TASK_ORBIT_STORE_KEY = 'tasks';

/** store 名: 按 did 短名确定性命名 */
export function taskStoreName(did: string): string {
  const short = String(did || 'local').replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 40) || 'local';
  return `bolloon-tasks-${short}`;
}

export interface TaskOrbitStore {
  readonly storeName: string;
  readonly storeAddress: string;
  ready: boolean;
  /** 预热: 打开 OrbitDB keyvalue store (幂等). 失败静默 → ready=false. */
  warm(): Promise<boolean>;
  /** 从 OrbitDB 读整个任务数组; 未就绪或失败返回 null (调用方 fallback 本地) */
  loadTasks(): Promise<unknown[] | null>;
  /** 全量写任务数组到 OrbitDB; 未就绪/失败返回 false */
  saveTasks(tasks: unknown[]): Promise<boolean>;
  /** 退订 + 关闭 (测试/退出用) */
  close(): Promise<void>;
}

/** 真实实现 (OrbitDB). 单例: 同一进程共享 CID 数据库单例. */
export class OrbitDBTaskStore implements TaskOrbitStore {
  private _store: OrbitDBStore | null = null;
  ready = false;
  storeName: string;
  storeAddress = '';

  constructor(
    private did: string,
    private db: CIDDatabase = getCIDDatabase(),
  ) {
    this.storeName = taskStoreName(did);
  }

  async warm(): Promise<boolean> {
    if (this.ready && this._store) return true;
    try {
      this._store = await this.db.openStore(this.storeName, 'keyvalue');
      this.storeAddress = this._store.address;
      this.ready = true;
      return true;
    } catch (err) {
      // OrbitDB 不可用 (离线/首次/测试环境) → 静默回退本地
      try { console.warn(`[task-store] OrbitDB 任务存储不可用, 回退本地: ${(err as Error)?.message?.slice(0, 120)}`); } catch { /* 忽略 */ }
      this.ready = false;
      return false;
    }
  }

  async loadTasks(): Promise<unknown[] | null> {
    if (!this.ready || !this._store) return null;
    try {
      const v = await this._store.get(TASK_ORBIT_STORE_KEY);
      if (v == null) return null;
      if (Array.isArray(v)) return v;
      return null;
    } catch {
      return null;
    }
  }

  async saveTasks(tasks: unknown[]): Promise<boolean> {
    if (!this.ready || !this._store) return false;
    try {
      await this._store.put(TASK_ORBIT_STORE_KEY, tasks);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this._store = null;
    this.ready = false;
  }
}

let _instance: TaskOrbitStore | null = null;
let _warmPromise: Promise<boolean> | null = null;

/** 获取任务 OrbitDB 存储单例 (首次调用时 warm). did 为 '' 时用 'local'. */
export function getTaskOrbitStore(did: string = ''): TaskOrbitStore {
  if (!_instance) _instance = new OrbitDBTaskStore(did || 'local');
  return _instance;
}

/** 预热任务 OrbitDB 存储 (server 启动时调用, 幂等). 返回是否就绪. */
export function warmTaskOrbitStore(did: string = ''): Promise<boolean> {
  if (!_warmPromise) {
    const store = getTaskOrbitStore(did);
    _warmPromise = store.warm().then((ok) => ok).catch(() => false);
  }
  return _warmPromise;
}

/** 重置单例 (测试用) */
export function resetTaskOrbitStore(): void {
  _instance = null;
  _warmPromise = null;
}

/** 用 did 短名构造 task store 名 (供 server 组装 store name 展示) */
export function taskStorePath(did: string, home: string = homeRoot()): string {
  return path.join(home, '.bolloon', 'orbitdb', 'stores', taskStoreName(did));
}
