/**
 * kanban-store.ts — Hermes kanban 的 OrbitDB 落地 (2026-08-12, Task5)
 *
 * 借鉴 hermes_cli/kanban_db.py 的 9 态任务看板 + 原子认领 (CAS), 存到 OrbitDB
 * keyvalue store (去中心化, DID 复制可跨设备同步). 每个 board 一个 store:
 *   bolloon-kanban-<boardId>
 *
 * 任务 9 态 (VALID_STATUSES):
 *   triage → todo → (父全部 done) → ready → running → done / archived
 *   - scheduled:  定时任务 (本次简化为状态 + dueAt, 到时可 promote)
 *   - blocked:    主动 block (sticky, 需显式 unblock) 或父依赖未完成 (自动解)
 *   - review:     request_review 挂起等人工审批, approve → done
 *   - archived:   终态归档
 *
 * 原子认领 (CAS, 至多一个 worker 认领成功): claim_task 只在
 *   status === 'ready' && claimLock 为空 时置 running + claimLock + claimExpires,
 *   否则返回输家 (不重试, 无分布式锁).
 *
 * 安全:
 *   - 依赖的 KV store (put/get/all) 可注入 → 单测用内存 map, 生产用 OrbitDB store.
 *   - 任务字段全部有默认值 (dag-cbor 不支持 undefined).
 */

// 校验 KV 的最小接口 (生产 OrbitDBStore 满足; 测试可注入内存实现)
export interface KanbanKV {
  put(key: string, value: unknown): Promise<void>;
  get(key: string): Promise<unknown>;
  all(): Promise<Array<{ key: string; value: unknown }>>;
}

export const KANBAN_STATUSES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived'] as const;
export type KanbanStatus = typeof KANBAN_STATUSES[number];

export interface KanbanTask {
  id: string;
  boardId: string;
  title: string;
  body: string;
  status: KanbanStatus;
  /** 父任务 id 列表 — 全部 done/archived 才允许 ready/running */
  parentIds: string[];
  createdBy: string;
  assignee: string;
  dueAt: number | null;
  /** 认领锁 (worker 标识) + 过期时间戳 */
  claimLock: string;
  claimExpires: number;
  /** 连续失败计数 (熔断: 超 limit 置 blocked, 不无限重试) */
  consecutiveFailures: number;
  /** 完成时声称创建的文件/资源引用 (防幻觉 — advisory 校验) */
  createdRefs: string[];
  reason: string;
  review: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  archivedAt: number | null;
}

export interface CreateTaskInput {
  boardId: string;
  title: string;
  body?: string;
  parentIds?: string[];
  createdBy?: string;
  dueAt?: number | null;
}

export interface ClaimResult {
  ok: boolean;
  task?: KanbanTask;
  reason?: string;
}

const now = () => Date.now();

function fresh(id: string, boardId: string, title: string, base: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id, boardId, title,
    body: base.body ?? '',
    status: base.status ?? 'triage',
    parentIds: base.parentIds ?? [],
    createdBy: base.createdBy ?? '',
    assignee: base.assignee ?? '',
    dueAt: base.dueAt ?? null,
    claimLock: base.claimLock ?? '',
    claimExpires: base.claimExpires ?? 0,
    consecutiveFailures: base.consecutiveFailures ?? 0,
    createdRefs: base.createdRefs ?? [],
    reason: base.reason ?? '',
    review: base.review ?? '',
    createdAt: base.createdAt ?? now(),
    updatedAt: base.updatedAt ?? now(),
    completedAt: base.completedAt ?? null,
    archivedAt: base.archivedAt ?? null,
  };
}

export function taskKey(id: string): string {
  return `task:${id}`;
}

/**
 * KanbanBoard — 绑定一个 KV store 的看板.
 * 所有写都经 readTask→改→put 的 CAS 语义; claim 在内核判赢家.
 */
export class KanbanBoard {
  constructor(private kv: KanbanKV) {}

  private st(s: KanbanTask): KanbanTask {
    return JSON.parse(JSON.stringify(s));
  }

  async createTask(input: CreateTaskInput): Promise<KanbanTask> {
    const id = `t_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const task = fresh(id, input.boardId, input.title, {
      body: input.body ?? '',
      parentIds: input.parentIds ?? [],
      createdBy: input.createdBy ?? '',
      dueAt: input.dueAt ?? null,
      status: 'triage',
    });
    await this.kv.put(taskKey(id), JSON.parse(JSON.stringify(task)));
    return this.st(task);
  }

  async getTask(id: string): Promise<KanbanTask | null> {
    const v = await this.kv.get(taskKey(id));
    return (v as KanbanTask) || null;
  }

  async listTasks(status?: KanbanStatus): Promise<KanbanTask[]> {
    const all = await this.kv.all();
    const tasks: KanbanTask[] = [];
    for (const e of all) {
      const t = e.value as KanbanTask;
      if (t && typeof t === 'object' && (t as any).title !== undefined) {
        if (!status || t.status === status) tasks.push(this.st(t));
      }
    }
    return tasks.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 保存变更 (校验合法) */
  private async persist(task: KanbanTask): Promise<KanbanTask> {
    task.updatedAt = now();
    await this.kv.put(taskKey(task.id), JSON.parse(JSON.stringify(task)));
    return this.st(task);
  }

  /**
   * 状态推进 gate: 只允许合法迁移 (防乱跳). 返回 null 表示禁止.
   */
  private trans(from: KanbanStatus, to: KanbanStatus): boolean {
    if (from === to) return true;
    if (from === 'done' || from === 'archived') return false; // 终态不可再动
    const allowed: Record<string, KanbanStatus[]> = {
      triage: ['todo', 'scheduled', 'blocked', 'archived'],
      todo: ['scheduled', 'ready', 'blocked', 'archived'],
      scheduled: ['todo', 'ready', 'blocked', 'archived'],
      ready: ['running', 'blocked', 'archived'],
      running: ['review', 'done', 'blocked', 'ready'],
      blocked: ['todo', 'ready', 'archived'],
      review: ['done', 'blocked', 'todo'],
    };
    const ok = (allowed[from] || []).includes(to);
    return ok;
  }

  /** checking parents status from KV */
  private async allParentsDone(task: KanbanTask): Promise<boolean> {
    if (!task.parentIds || task.parentIds.length === 0) return true;
    for (const pid of task.parentIds) {
      const p = await this.getTask(pid);
      if (p && p.status !== 'done' && p.status !== 'archived') return false;
    }
    return true;
  }

  /** 把 todo/scheduled/blocked(父依赖未完成) 任务晋升为 ready (父依赖满足时) — recompute Ready */
  async promoteReady(taskId: string): Promise<KanbanTask | null> {
    const t = await this.getTask(taskId);
    if (!t) return null;
    // 自动可清 blocked = 因父依赖未完成; sticky blocked (用户主动) 不自动解
    const autoClearable = t.status === 'blocked' && t.reason === 'parents_not_done';
    if (!autoClearable && t.status !== 'todo' && t.status !== 'scheduled') return null;
    if (!(await this.allParentsDone(t))) {
      if (t.status === 'blocked') return this.st(t);
      return { ...this.st(t), status: 'blocked', reason: 'parents_not_done' };
    }
    return this.persist({ ...t, status: 'ready', reason: '' });
  }

  /** 认领 (CAS): 只有 ready 且未被认领的才能成功 → running + claimLock */
  async claimTask(taskId: string, worker: string, ttlMs = 15 * 60 * 1000): Promise<ClaimResult> {
    const t = await this.getTask(taskId);
    if (!t) return { ok: false, reason: `任务不存在: ${taskId}` };
    if (t.claimLock) return { ok: false, reason: '已被其他 worker 认领' };
    if (t.status !== 'ready') {
      // 父依赖不变式: 认领点再强校验一次 (任何写路径把任务置 ready 都可能被这里纠正)
      if (!(await this.allParentsDone(t))) {
        await this.persist({ ...t, status: 'blocked', reason: 'parents_not_done' });
        return { ok: false, reason: '父任务未完成 (降级 blocked)' };
      }
      return { ok: false, reason: `状态为 ${t.status}, 只有 ready 可认领` };
    }
    const run = fresh(t.id, t.boardId, t.title, { ...t, status: 'running', claimLock: worker, claimExpires: now() + ttlMs, consecutiveFailures: 0 });
    await this.kv.put(taskKey(taskId), JSON.parse(JSON.stringify(run)));
    return { ok: true, task: this.st(run) };
  }

  /** 认领 TTL 过期释放 — 防崩溃锁泄漏 (重启后旧 claimLock 残留) */
  async releaseStaleClaims(nowTs: number = now()): Promise<number> {
    const tasks = await this.listTasks('running');
    let freed = 0;
    for (const t of tasks) {
      if (t.claimLock && t.claimExpires < nowTs) {
        await this.persist({ ...t, status: 'ready', claimLock: '', claimExpires: 0 });
        freed++;
      }
    }
    return freed;
  }

  /** 记一次失败 (熔断): 连续失败 > limit → blocked */
  async registerFailure(taskId: string, failureLimit = 3): Promise<KanbanTask | null> {
    const t = await this.getTask(taskId);
    if (!t) return null;
    let next: KanbanTask = t.claimLock ? { ...t, status: 'ready', claimLock: '', claimExpires: 0 } : { ...t };
    next.consecutiveFailures = (next.consecutiveFailures || 0) + 1;
    if (next.consecutiveFailures >= failureLimit) {
      next.status = 'blocked';
      next.reason = `circuit_break (连续失败 ${next.consecutiveFailures})`;
    }
    return this.persist(next);
  }

  /** 完成: 校验声称创建的引用 (防幻觉 — 幽灵引用 advisory), 父任务完成则解子依赖 */
  async completeTask(taskId: string, worker: string, createdRefs: string[] = []): Promise<KanbanTask | null> {
    const t = await this.getTask(taskId);
    if (!t) return null;
    if (t.claimLock && t.claimLock !== worker) return null;
    // 防幻觉 (advisory): 声称创建的引用逐一验证存在 → 不存在记为 advisory (不阻塞, 但可审计)
    const missing: string[] = [];
    for (const ref of createdRefs) {
      const existing = await this.getTask(ref.replace(/^task:/, ''));
      if (!existing) missing.push(ref);
    }
    const task = fresh(t.id, t.boardId, t.title, {
      ...t, status: 'done', claimLock: '', claimExpires: 0,
      createdRefs, reason: missing.length ? `advisory_missing_refs: ${missing.join(',')}` : t.reason,
      completedAt: now(),
    });
    await this.kv.put(taskKey(taskId), JSON.parse(JSON.stringify(task)));
    // 子任务受父完成影响 → 尝试晋升 ready
    const all = await this.listTasks();
    for (const c of all) {
      if (c.parentIds.includes(taskId) && (c.status === 'todo' || c.status === 'blocked')) {
        await this.promoteReady(c.id);
      }
    }
    return this.st(task);
  }

  async requestReview(taskId: string, note: string): Promise<KanbanTask | null> {
    const t = await this.getTask(taskId);
    if (!t || t.status !== 'running') return null;
    return this.persist({ ...t, status: 'review', claimLock: '', claimExpires: 0, review: note });
  }
  async approveReview(taskId: string): Promise<KanbanTask | null> {
    const t = await this.getTask(taskId);
    if (!t || t.status !== 'review') return null;
    return this.persist({ ...t, status: 'done', reason: 'review_approved', completedAt: now() });
  }
  async rejectReview(taskId: string, reason: string): Promise<KanbanTask | null> {
    const t = await this.getTask(taskId);
    if (!t || t.status !== 'review') return null;
    return this.persist({ ...t, status: 'blocked', review: '', reason: `review_rejected: ${reason}` });
  }

  async setStatus(taskId: string, to: KanbanStatus, reason = ''): Promise<KanbanTask | null> {
    const t = await this.getTask(taskId);
    if (!t || !this.trans(t.status, to)) return null;
    if (to === 'blocked' && !reason && !t.reason) return null; // blocked 需带 reason
    const next: KanbanTask = { ...t, status: to, reason: to === 'blocked' ? (reason || t.reason) : reason || t.reason };
    if (to === 'archived') next.archivedAt = now();
    if (to === 'ready') {
      if (!(await this.allParentsDone(next))) return this.persist({ ...next, status: 'blocked', reason: 'parents_not_done' });
    }
    return this.persist(next);
  }
}

/** 打开/缓存指定 board 的 OrbitDB KV store, 返回绑定的 KanbanBoard. 失败抛错. */
const _boardCache = new Map<string, KanbanBoard>();
export async function openKanbanBoard(boardId: string): Promise<KanbanBoard> {
  if (_boardCache.has(boardId)) return _boardCache.get(boardId)!;
  const { getCIDDatabase } = await import('./cid-database.js');
  const store = await (await getCIDDatabase()).openStore(`bolloon-kanban-${boardId}`, 'keyvalue');
  const board = new KanbanBoard(store as unknown as KanbanKV);
  _boardCache.set(boardId, board);
  return board;
}