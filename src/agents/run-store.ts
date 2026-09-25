/**
 * run-store.ts — 持久化 run harness (2026-09-16)
 *
 * 问题 (leo 2026-09-16): web / cli 页面只是**单次执行** —— 一条消息进来跑一遍 agent 循环,
 * 跑完就没了。进程重载 / 刷新页面 / 崩一次, 这次运行的全部状态 (做了什么、做到哪、为什么停)
 * 都不留痕, 也没有任何常驻闸门约束它 (现有 reactHarness 只在单次 prompt 内存里活着)。
 *
 * 这一层补的就是"持久化 + 约束":
 *   ① 每次 agent 运行 = 一条落盘记录 ~/.bolloon/runs/<runId>.json (跨进程/跨重载可读)
 *   ② 每次工具调用追加一步 (原子写: 临时文件 + rename), 崩了也能看到做到哪一步
 *   ③ 预算闸门: maxSteps / deadlineMs 到点必须**如实**结束 (failed/aborted), 不许静默算完成
 *   ④ 孤儿对账: 进程启动时把 pid 已死的 running 记录改判 interrupted (不假装还在跑)
 *   ⑤ 失速巡检: 常驻巡检把长时间没更新的 running 标 stalled (给 UI/CLI 一个诚实的说法)
 *
 * 记录是**事实**层: 只写实际发生的步骤与结果, 不写"预期/希望"。
 */

import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export type RunSurface = 'cli' | 'web' | 'mobile' | 'cron' | 'delegate';

/**
 * 统一运行状态 (2026-09-16 Phase 0, 对齐 Durable Pi Agent Runtime 协议):
 *   queued 排队 → running 执行 → done 完成 / failed 失败 / aborted 主动中止
 *   recovering 恢复中 · paused 暂停 · awaiting_external 等外部 · needs_human 等人
 *   interrupted 进程中断 (对账判的) · stalled 失速 (巡检判的)
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'recovering'
  | 'paused'
  | 'awaiting_external'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'interrupted'
  | 'stalled'
  | 'needs_human';

/** 合法状态迁移 (协议的一部分: 非法迁移一律拒绝, 防止"偷偷回到 running"这类假状态) */
export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['running', 'aborted', 'interrupted'],
  running: ['recovering', 'paused', 'awaiting_external', 'done', 'failed', 'aborted', 'interrupted', 'stalled', 'needs_human'],
  recovering: ['running', 'failed', 'aborted', 'needs_human', 'interrupted', 'stalled'],
  paused: ['running', 'aborted', 'interrupted'],
  awaiting_external: ['running', 'failed', 'aborted', 'interrupted', 'stalled'],
  done: [],
  failed: [],
  aborted: [],
  interrupted: ['recovering', 'aborted'],   // 允许"从 checkpoint 恢复"
  stalled: ['recovering', 'aborted', 'needs_human'],
  needs_human: ['running', 'aborted'],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  return (RUN_TRANSITIONS[from] || []).includes(to);
}

/** 错误分类 → 默认恢复动作 (Phase 3 协议表; 只是**决策记录**, 执行在 Recovery Engine) */
export type ErrorClass =
  | 'transient'        // 网络抖动 / 429 / 5xx → 指数退避重试
  | 'auth'             // 鉴权失败 → 不重试, 交人 (needs_human)
  | 'bad_args'         // 工具参数错 → 修正重试一次
  | 'no_such_tool'     // 工具不存在/能力不匹配 → 换工具或重规划
  | 'policy_denied'    // 权限/安全 gate 拒绝 → 不重试, 走策略分支
  | 'external_no_reply'// 外部节点无响应 → awaiting_external
  | 'unparsable'       // 模型输出不可解析 → 重提示一次再暂停
  | 'repeat_failure'   // 重复失败 → 熔断 needs_human
  | 'crash'            // 进程崩溃 → 从最近 checkpoint 恢复
  | 'corrupt_state'    // 状态文件损坏 → 用最后有效 checkpoint + 记数据修复事件
  | 'persist_failed'   // 2026-09-16 (Milestone 1): 核心运行状态**写不进去** → 停, 不许无记录继续执行
  | 'unknown';

/** 每次恢复必须留下的记录 (Phase 3: 分类/次数/策略/前后 checkpoint/是否改计划/是否成功) */
export interface RecoveryAttempt {
  ts: string;
  errorClass: ErrorClass;
  message: string;
  action: 'retry' | 'backoff' | 'resume' | 'fallback' | 'pause' | 'escalate' | 'fail' | 'none';
  attempt: number;
  checkpointBefore?: number;
  checkpointAfter?: number;
  changedPlan?: boolean;
  recovered?: boolean;
}

/**
 * 2026-09-16 (Milestone 1-B): Harness 生命周期事件 (决策留痕)。
 * 只留最近 MAX_HARNESS_EVENTS 条 —— 这是审计账本, 不是全量日志。
 */
export interface HarnessTraceEvent {
  ts: string;
  event: string;
  kind: 'allow' | 'deny' | 'degrade' | 'error' | 'note';
  failureKind?: string;
  tool?: string;
  reason?: string;
  source?: string;
  ms?: number;
  /** 运行身份 (Milestone 1-B: 事件都带 runId/goalId, 便于按目标回溯) */
  runId?: string;
  goalId?: string;
}

export const MAX_HARNESS_EVENTS = 50;

export interface RunStep {
  n: number;
  ts: string;
  tool: string;
  /** 参数摘要 (截断 + 去换行), 只做定位用, 不留敏感全文 */
  argsDigest?: string;
  ok: boolean;
  ms?: number;
  summary?: string;
  error?: string;
}

export interface RunCheckpoint {
  /** 已完成动作数 (步号) */
  completedActions: number;
  /** 正在做的那一步 */
  pendingAction?: string;
  /** 下一步该做什么 (恢复时的入口) */
  nextAction?: string;
  /** 上下文引用 (session key / channel / 文件路径等) */
  contextRef?: string;
  ts: string;
}

export interface RunRecord {
  runId: string;
  /** Phase 2: 与 Goal 强绑定 (Goal 不因一次 prompt 结束而消失) */
  goalId?: string;
  surface: RunSurface;
  goal: string;
  channelId?: string;
  agentId?: string;
  sessionKey?: string;
  pid: number;
  host: string;
  startedAt: string;
  updatedAt: string;
  status: RunStatus;
  steps: RunStep[];
  /** 约束: 到点必须如实结束 */
  budget: { maxSteps: number; deadlineMs: number };
  /** 最近一次 checkpoint (恢复入口) */
  checkpoint?: RunCheckpoint;
  /** Phase 3: 每次恢复尝试的留痕 */
  recovery: RecoveryAttempt[];
  /** 2026-09-16 (Milestone 1-B): Harness 生命周期决策留痕 (只留最近 MAX_HARNESS_EVENTS 条) */
  harness?: HarnessTraceEvent[];
  summary?: string;
  error?: string;
  errorClass?: ErrorClass;
  evidence?: string[];
}

export interface HarnessConfig {
  /** 单次运行最多工具步数 */
  maxSteps: number;
  /** 单次运行最长墙钟时间 (ms) */
  deadlineMs: number;
  /** running 超过这个时间没更新 → 判失速 (ms) */
  staleMs: number;
  /**
   * 2026-09-16 (Milestone 1): 持久化严格度。
   *   'strict' (默认) —— 核心状态写入失败 → 抛 RunPersistenceError, 调用方必须停 (不许无记录继续执行)
   *   'degraded'       —— 只记降级并返回 null (仅留给明确的弱环境; env BOLLOON_RUN_PERSIST=degraded)
   * 观测性写入 (SSE/UI/日志) 永远不进这个开关: 它们只能降级 + 留痕, 不能影响运行。
   */
  persistence: 'strict' | 'degraded';
  /** 跨进程 run 锁视为陈旧的时间 (ms): 持锁进程已死或超过这个时间 → 可回收 */
  lockStaleMs: number;
}

const DEFAULT_HARNESS: HarnessConfig = {
  maxSteps: Number(process.env.BOLLOON_RUN_MAX_STEPS || 60),
  deadlineMs: Number(process.env.BOLLOON_RUN_DEADLINE_MS || 30 * 60_000),
  staleMs: Number(process.env.BOLLOON_RUN_STALE_MS || 120_000),
  persistence: process.env.BOLLOON_RUN_PERSIST === 'degraded' ? 'degraded' : 'strict',
  lockStaleMs: Number(process.env.BOLLOON_RUN_LOCK_STALE_MS || 15_000),
};

export function runsDir(): string {
  return path.join(os.homedir(), '.bolloon', 'runs');
}

/**
 * 核心持久化失败 (不是"工具失败"): run 记录写不进去 = 这次运行在事实层面不存在。
 * 抛这个错的意义是让调用方**停**, 而不是 warn 之后继续跑 (那正是"agent 实际运行了但没记录"的来源)。
 */
export class RunPersistenceError extends Error {
  readonly op: string;
  readonly runId?: string;
  readonly underlying?: unknown;
  constructor(op: string, message: string, runId?: string, underlying?: unknown) {
    super(message);
    this.name = 'RunPersistenceError';
    this.op = op;
    this.runId = runId;
    this.underlying = underlying;
  }
}

/** 观测性降级留痕 (2026-09-16 Milestone 1): 观测失败可以继续跑, 但必须能在盘上看到 */
export interface PersistenceDegradation {
  ts: string;
  kind: 'core' | 'observational';
  op: string;
  runId?: string;
  message: string;
}

/** 降级日志位置: 主 (runs 目录内) + 兜底 (runs 目录写不进去时也能留痕, 例: 盘满/只读) */
function degradationPaths(): string[] {
  return [
    path.join(runsDir(), '_degradations.jsonl'),
    path.join(os.homedir(), '.bolloon', 'run-degradations.jsonl'),
  ];
}

/**
 * 记一条降级 (append-only jsonl)。
 * 这是"如实"底线: 观测/核心写失败可以不让运行崩, 但绝不允许静默消失。
 * 主路径写不进去 (典型: runs 目录只读/盘满 —— 正是最需要留痕的时候) → 退到 runs 目录之外再试一次。
 */
export async function recordDegradation(d: Omit<PersistenceDegradation, 'ts'>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...d }) + '\n';
  const paths = degradationPaths();
  for (const p of paths) {
    try {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.appendFile(p, line, 'utf8');
      return;
    } catch { /* 试下一个位置 */ }
  }
  // 哪都写不进去: 只能打到 stderr (绝不抛, 免得把"报告失败"变成"引发失败")
  console.error('[run-store] 降级日志写入失败:', line.trim());
}

export async function listDegradations(limit = 20): Promise<PersistenceDegradation[]> {
  const all: PersistenceDegradation[] = [];
  for (const p of degradationPaths()) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      for (const l of raw.split('\n')) {
        if (!l.trim()) continue;
        try { all.push(JSON.parse(l) as PersistenceDegradation); } catch { /* 坏行跳过 */ }
      }
    } catch { /* 位置不存在 */ }
  }
  all.sort((a, b) => (a.ts < b.ts ? 1 : -1));   // 新的在前
  return all.slice(0, limit);
}

async function persistenceMode(): Promise<HarnessConfig['persistence']> {
  return (await readHarnessConfig()).persistence;
}

/**
 * 核心写入的统一入口: 失败 → 记降级; strict 模式下抛 RunPersistenceError 让调用方停。
 * 所有"改 run 状态"的操作都必须走这里, 否则又会出现"某条路径 fail-open"。
 */
async function coreWrite<T>(op: string, runId: string | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = `${op} 失败: ${String((err as Error)?.message || err).slice(0, 200)}`;
    await recordDegradation({ kind: 'core', op, runId, message });
    if ((await persistenceMode()) === 'strict') {
      throw new RunPersistenceError(op, message, runId, err);
    }
    return null as T;
  }
}

/** 单次运行的预算 (可从 ~/.bolloon/harness.json 覆盖) */
export async function readHarnessConfig(): Promise<HarnessConfig> {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.bolloon', 'harness.json'), 'utf8');
    const j = JSON.parse(raw);
    return {
      maxSteps: Number(j.maxSteps) > 0 ? Number(j.maxSteps) : DEFAULT_HARNESS.maxSteps,
      deadlineMs: Number(j.deadlineMs) > 0 ? Number(j.deadlineMs) : DEFAULT_HARNESS.deadlineMs,
      staleMs: Number(j.staleMs) > 0 ? Number(j.staleMs) : DEFAULT_HARNESS.staleMs,
      persistence: j.persistence === 'degraded' ? 'degraded' : DEFAULT_HARNESS.persistence,
      lockStaleMs: Number(j.lockStaleMs) > 0 ? Number(j.lockStaleMs) : DEFAULT_HARNESS.lockStaleMs,
    };
  } catch {
    return { ...DEFAULT_HARNESS };
  }
}

function runPath(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}

function backupPath(runId: string): string {
  return `${runPath(runId)}.bak`;
}

function lockPath(runId: string): string {
  return path.join(runsDir(), `${runId}.lock`);
}

/**
 * 原子写 + 保留最后一份有效备份 (2026-09-16 Milestone 1)。
 *   .bak = 上一次**能被 JSON.parse 的成功内容** —— 损坏回退的载体 (不是简单复制, 坏内容不会被留成备份)。
 */
async function writeRun(rec: RunRecord): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true });
  const p = runPath(rec.runId);
  const tmp = `${p}.${process.pid}.tmp`;
  const body = JSON.stringify(rec, null, 2);
  try {
    const prev = await fs.readFile(p, 'utf8');
    JSON.parse(prev);                       // 只有解析得开才值得当备份
    await fs.writeFile(backupPath(rec.runId), prev, 'utf8');
  } catch { /* 没有上一版 / 上一版已损坏 → 不覆盖已有备份 */ }
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, p);
}

/**
 * 读 run 记录。文件损坏时回退到最后一份有效备份 (.bak), 并把这次修复记成一条 corrupt_state 恢复事件
 * (协议要求: 损坏 → 用最后有效状态 + 记数据修复事件, 而不是当成"没有这条运行")。
 */
export async function readRun(runId: string): Promise<RunRecord | null> {
  const p = runPath(runId);
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as RunRecord;
  } catch (err) {
    const isMissing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    if (isMissing) return null;
    try {
      const recovered = JSON.parse(await fs.readFile(backupPath(runId), 'utf8')) as RunRecord;
      recovered.recovery = recovered.recovery || [];
      recovered.recovery.push({
        ts: new Date().toISOString(),
        errorClass: 'corrupt_state',
        message: `运行记录损坏, 已回退到最后一份有效备份 (.bak): ${String((err as Error)?.message || err).slice(0, 150)}`,
        action: 'resume',
        attempt: recovered.recovery.length + 1,
        recovered: true,
      });
      recovered.updatedAt = new Date().toISOString();
      await writeRun(recovered);            // 用最后有效状态把主文件修回来
      await recordDegradation({ kind: 'core', op: 'readRun.repair', runId, message: '记录损坏, 已用 .bak 修复' });
      return recovered;
    } catch {
      await recordDegradation({ kind: 'core', op: 'readRun', runId, message: `记录损坏且无有效备份: ${String((err as Error)?.message || err).slice(0, 150)}` });
      return null;
    }
  }
}

export async function listRuns(opts: { status?: RunStatus | RunStatus[]; limit?: number } = {}): Promise<RunRecord[]> {
  let files: string[] = [];
  try { files = await fs.readdir(runsDir()); } catch { return []; }
  const out: RunRecord[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const r = await readRun(f.replace(/\.json$/, ''));
    if (!r) continue;
    if (opts.status) {
      const want = Array.isArray(opts.status) ? opts.status : [opts.status];
      if (!want.includes(r.status)) continue;
    }
    out.push(r);
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-16 (Milestone 1): 同一 run 的写入串行化 —— 进程内 promise 链 + 跨进程 lock 文件。
//   没有这一层, 并发 recordStep 是 read-modify-write 竞态: 后写的会覆盖先写的步骤 (丢步)。
// ─────────────────────────────────────────────────────────────────────────────
const runLocks = new Map<string, Promise<unknown>>();

/** 拿跨进程锁: `wx` 独占创建; 持有者已死或锁已陈旧 → 回收后重试 (只删陈旧的那把) */
async function acquireFileLock(runId: string): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true });
  const lp = lockPath(runId);
  const cfg = await readHarnessConfig();
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const fh = await fs.open(lp, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), ts: new Date().toISOString() }), 'utf8');
      await fh.close();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // 拿不到锁文件本身 (EACCES/ENOSPC/EROFS...) = 这块盘写不了 → 必须让调用方知道这是持久化失败,
      // 不能退化成一个"普通异常"被上层当成偶发错误吞掉 (否则又是一条隐形 fail-open 路径)。
      if (code !== 'EEXIST') {
        throw new RunPersistenceError('acquireFileLock', `run 锁不可创建 (${code || 'unknown'}): ${String((err as Error)?.message || err).slice(0, 150)}`, runId, err);
      }
      let stale = false;
      try {
        const info = JSON.parse(await fs.readFile(lp, 'utf8'));
        stale = !pidAlive(Number(info?.pid)) || Date.now() - Date.parse(String(info?.ts || '')) > cfg.lockStaleMs;
      } catch { stale = true; }   // 锁文件本身坏了 → 当作陈旧
      if (stale) {
        await recordDegradation({ kind: 'observational', op: 'run-lock.reclaim', runId, message: '回收陈旧 run 锁' });
        await fs.rm(lp, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new RunPersistenceError('withRunLock', `另一个进程正持有 run 锁: ${runId}`, runId);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/** 只释放自己持有的锁 (进程死了会被 acquireFileLock 按 pid 判定为陈旧回收) */
async function releaseFileLock(runId: string): Promise<void> {
  try {
    const info = JSON.parse(await fs.readFile(lockPath(runId), 'utf8'));
    if (Number(info?.pid) === process.pid) await fs.rm(lockPath(runId), { force: true });
  } catch { /* 不存在/已坏 → 无需处理 */ }
}

/**
 * 在 run 锁内执行一段读改写 (并发写入不覆盖步骤)。
 * 拿不到锁也按同一套等级处理: strict → 抛 (停); degraded → 记降级后**不加锁继续** (仅明确选择降级的弱环境)。
 */
export async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const prev = runLocks.get(runId) || Promise.resolve();
  const mine = prev.catch(() => {}).then(async () => {
    let locked = false;
    try {
      await acquireFileLock(runId);
      locked = true;
    } catch (err) {
      const message = `run 锁获取失败: ${String((err as Error)?.message || err).slice(0, 160)}`;
      await recordDegradation({ kind: 'core', op: 'withRunLock', runId, message });
      if ((await persistenceMode()) === 'strict') {
        throw err instanceof RunPersistenceError ? err : new RunPersistenceError('withRunLock', message, runId, err);
      }
    }
    try { return await fn(); }
    finally { if (locked) await releaseFileLock(runId); }
  });
  const tail = mine.catch(() => {});
  runLocks.set(runId, tail);
  try { return await mine; }
  finally { if (runLocks.get(runId) === tail) runLocks.delete(runId); }
}

export interface StartRunOptions {
  surface: RunSurface;
  goal: string;
  goalId?: string;
  channelId?: string;
  agentId?: string;
  sessionKey?: string;
}

export async function startRun(opts: StartRunOptions): Promise<RunRecord> {
  const cfg = await readHarnessConfig();
  const now = new Date().toISOString();
  const rec: RunRecord = {
    runId: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    goalId: opts.goalId,
    surface: opts.surface,
    goal: String(opts.goal || '').slice(0, 500),
    channelId: opts.channelId,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    pid: process.pid,
    host: os.hostname(),
    startedAt: now,
    updatedAt: now,
    status: 'running',
    steps: [],
    budget: { maxSteps: cfg.maxSteps, deadlineMs: cfg.deadlineMs },
    recovery: [],
  };
  await coreWrite('startRun', rec.runId, () => writeRun(rec));
  return rec;
}

/** 错误分类 (Phase 3 表): 决定默认恢复动作, 是"决策的事实"而不是猜测 */
export function classifyError(message: string): ErrorClass {
  const m = String(message || '').toLowerCase();
  // 注意顺序: "无响应/504" 属外部等待 (awaiting_external), 不能先被 transient 吃掉
  if (/(external|no reply|无响应|对端|peer.*no|504)/.test(m)) return 'external_no_reply';
  // 持久化写失败 (run 记录本身写不进去) 优先于鉴权/网络判断: 它的处置是"停", 不是"重试"
  if (/(run-store|run 记录|run 锁|记录损坏|persist_failed|持久化)/.test(m)) return 'persist_failed';
  // 进程崩了/被杀 (启动对账判的 interrupted) → 从最近 checkpoint 恢复
  if (/(进程 \d+ 已不在|process .*\b(gone|dead)\b|崩溃|crash|killed)/.test(m)) return 'crash';
  if (/(401|403|402|unauthori[sz]ed|invalid api key|authentication fails|permission denied|鉴权|api.?key)/.test(m)) return 'auth';
  if (/(429|rate limit|timeout|timed out|econnreset|etimedout|temporarily|503|502|网络|抖动)/.test(m)) return 'transient';
  if (/(invalid argument|缺少参数|bad args|参数)/.test(m)) return 'bad_args';
  if (/(no such tool|unknown tool|not found|能力不匹配|no-capability-match)/.test(m)) return 'no_such_tool';
  if (/(denied|拒绝|blocked|denylist|policy|gate)/.test(m)) return 'policy_denied';
  if (/(unparsable|parse|解析失败|no tool call)/.test(m)) return 'unparsable';
  return 'unknown';
}

/**
 * 状态迁移 (带校验): 非法迁移直接拒绝, 避免"偷偷回到 running"这种假状态。
 * 写入失败在 strict 模式下抛 RunPersistenceError (调用方必须停)。
 */
export async function setRunStatus(
  runId: string,
  to: RunStatus,
  patch: Partial<Pick<RunRecord, 'summary' | 'error' | 'evidence' | 'errorClass'>> = {},
): Promise<{ ok: boolean; reason?: string; record?: RunRecord }> {
  return withRunLock(runId, () => coreWrite('setRunStatus', runId, async () => {
    const rec = await readRun(runId);
    if (!rec) return { ok: false, reason: `run 不存在: ${runId}` };
    if (!canTransition(rec.status, to)) {
      return { ok: false, reason: `非法状态迁移 ${rec.status} → ${to}` };
    }
    rec.status = to;
    if (patch.summary) rec.summary = String(patch.summary).replace(/\s+/g, ' ').slice(0, 800);
    if (patch.error) {
      rec.error = String(patch.error).replace(/\s+/g, ' ').slice(0, 400);
      rec.errorClass = patch.errorClass || classifyError(patch.error);
    }
    if (patch.evidence) rec.evidence = patch.evidence.slice(0, 20);
    rec.updatedAt = new Date().toISOString();
    await writeRun(rec);
    return { ok: true, record: rec };
  }));
}

/** 写 checkpoint (恢复入口: 做到哪、下一步是什么) */
export async function saveCheckpoint(
  runId: string,
  cp: Omit<RunCheckpoint, 'ts'>,
): Promise<RunRecord | null> {
  return withRunLock(runId, () => coreWrite('saveCheckpoint', runId, async () => {
    const rec = await readRun(runId);
    if (!rec) return null;
    rec.checkpoint = { ...cp, ts: new Date().toISOString() };
    rec.updatedAt = new Date().toISOString();
    await writeRun(rec);
    return rec;
  }));
}

/** 记一次恢复尝试 (Phase 3: 分类/策略/前后 checkpoint/是否改计划/是否恢复) */
export async function recordRecovery(
  runId: string,
  attempt: Omit<RecoveryAttempt, 'ts' | 'attempt'> & { attempt?: number },
): Promise<RunRecord | null> {
  return withRunLock(runId, () => coreWrite('recordRecovery', runId, async () => {
    const rec = await readRun(runId);
    if (!rec) return null;
    rec.recovery = rec.recovery || [];
    rec.recovery.push({
      ts: new Date().toISOString(),
      attempt: attempt.attempt ?? rec.recovery.length + 1,
      ...attempt,
    } as RecoveryAttempt);
    rec.updatedAt = new Date().toISOString();
    await writeRun(rec);
    return rec;
  }));
}

/**
 * 记一条 Harness 生命周期事件 (Milestone 1-B)。
 *
 * 刻意用**观测级**写入: 决策已经做出了, 记账失败绝不改变决策 (记录是账, 不是闸)。
 * 但失败会落降级日志 —— 不允许"没记上"被当成"没发生"。
 */
export async function recordHarnessEvent(runId: string, evt: HarnessTraceEvent): Promise<void> {
  try {
    await withRunLock(runId, async () => {
      const rec = await readRun(runId);
      if (!rec) return;
      rec.harness = rec.harness || [];
      rec.harness.push(evt);
      if (rec.harness.length > MAX_HARNESS_EVENTS) {
        rec.harness = rec.harness.slice(-MAX_HARNESS_EVENTS);   // 审计账本: 只留最近 N 条
      }
      rec.updatedAt = new Date().toISOString();
      await writeRun(rec);
    });
  } catch (err) {
    await recordDegradation({ kind: 'observational', op: 'recordHarnessEvent', runId, message: `${evt.event}/${evt.kind} 写入失败: ${String((err as Error)?.message || err).slice(0, 150)}` });
  }
}

/** 防止"同一个工具 + 同一组参数"无限重试: 返回该指纹最近的连续失败次数 */
export function repeatedFailureCount(rec: RunRecord, tool: string, argsDigest?: string): number {
  let n = 0;
  for (let i = rec.steps.length - 1; i >= 0; i--) {
    const s = rec.steps[i];
    if (s.tool !== tool) break;
    if (argsDigest && s.argsDigest && s.argsDigest !== argsDigest) break;
    if (s.ok) break;
    n++;
  }
  return n;
}

function digest(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return String(s || '').replace(/\s+/g, ' ').slice(0, 160);
  } catch {
    return '';
  }
}

/** 工具参数指纹 (与 Step.argsDigest 同一算法) — 恢复重放守卫要靠它比对"同一次调用" */
export function argsDigestOf(v: unknown): string {
  return digest(v);
}

/**
 * 追加一步 (工具调用后立即落盘) —— 崩在这里也能看到做到哪一步。
 * 锁内读改写: 并发调用不会互相覆盖步骤。
 */
/**
 * 追加证据到 Run (2026-09-16): 交易等"外部事实"要能进 Run 的 evidence,
 * 而不是只留在工具内部 (支付必须可审计)。
 */
export async function addRunEvidence(runId: string, lines: string[]): Promise<RunRecord | null> {
  return withRunLock(runId, () => coreWrite('addRunEvidence', runId, async () => {
    const rec = await readRun(runId);
    if (!rec) return null;
    const merged = Array.from(new Set([...(rec.evidence || []), ...lines.map((l) => String(l).slice(0, 300))])).slice(-50);
    rec.evidence = merged;
    await writeRun(rec);
    return rec;
  }));
}

export async function recordStep(runId: string, step: { tool: string; ok: boolean; ms?: number; args?: unknown; summary?: string; error?: string }): Promise<RunRecord | null> {
  return withRunLock(runId, () => coreWrite('recordStep', runId, async () => {
    const rec = await readRun(runId);
    if (!rec) return null;
    rec.steps.push({
      n: rec.steps.length + 1,
      ts: new Date().toISOString(),
      tool: step.tool,
      argsDigest: step.args === undefined ? undefined : digest(step.args),
      ok: step.ok,
      ms: step.ms,
      summary: step.summary ? String(step.summary).replace(/\s+/g, ' ').slice(0, 200) : undefined,
      error: step.error ? String(step.error).replace(/\s+/g, ' ').slice(0, 200) : undefined,
    });
    rec.updatedAt = new Date().toISOString();
    // 每步自动写 checkpoint (恢复入口: 做到哪一步 + 下一步从哪接)
    rec.checkpoint = {
      completedActions: rec.steps.length,
      pendingAction: step.tool,
      nextAction: '由这一步的结果决定 (恢复时先读最近一步的 summary/error)',
      contextRef: rec.sessionKey || rec.channelId || rec.agentId,
      ts: rec.updatedAt,
    };
    await writeRun(rec);
    return rec;
  }));
}

export async function finishRun(
  runId: string,
  patch: { status: Exclude<RunStatus, 'running'>; summary?: string; error?: string; evidence?: string[] },
): Promise<RunRecord | null> {
  return withRunLock(runId, () => coreWrite('finishRun', runId, () => finishRunUnlocked(runId, patch)));
}

/** 锁内版本 (给 reconcileOrphans / superviseRuns 等已经持有锁的路径用) */
async function finishRunUnlocked(
  runId: string,
  patch: { status: Exclude<RunStatus, 'running'>; summary?: string; error?: string; evidence?: string[] },
): Promise<RunRecord | null> {
  const rec = await readRun(runId);
  if (!rec) return null;
  if (!canTransition(rec.status, patch.status)) return null;   // 非法迁移拒绝 (协议约束)
  rec.status = patch.status;
  rec.summary = patch.summary ? String(patch.summary).replace(/\s+/g, ' ').slice(0, 800) : rec.summary;
  if (patch.error) {
    rec.error = String(patch.error).replace(/\s+/g, ' ').slice(0, 400);
    rec.errorClass = classifyError(patch.error);
  }
  if (patch.evidence) rec.evidence = patch.evidence.slice(0, 20);
  rec.updatedAt = new Date().toISOString();
  await writeRun(rec);
  return rec;
}

/** 预算闸门: 超了必须如实结束 (调用方负责把结论写回去) */
export function budgetVerdict(rec: RunRecord, now = Date.now()): { exceeded: boolean; reason?: string } {
  if (rec.steps.length >= rec.budget.maxSteps) {
    return { exceeded: true, reason: `步数预算用尽 (${rec.steps.length}/${rec.budget.maxSteps})` };
  }
  const elapsed = now - Date.parse(rec.startedAt);
  if (elapsed > rec.budget.deadlineMs) {
    return { exceeded: true, reason: `时间预算用尽 (${Math.round(elapsed / 1000)}s/${Math.round(rec.budget.deadlineMs / 1000)}s)` };
  }
  return { exceeded: false };
}

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/**
 * Run 被底层状态机判成**终止**时的回调 (注册点)。
 *
 * ★ 2026-09-25 (M0 接线冻结, 规则 ④): 崩溃恢复 (`reconcileOrphans` → interrupted) 与
 * 失速 (`superviseRuns` → stalled) 也是"Run 的终止", 因此必须能进唯一责任链
 * (Run → closeRun → Memory/Skill → 下一次 continuation)。
 *
 * 为什么是注册点而不是直接 import 飞轮: `run-store` 是**事实层**, 它不认识 Goal, 也不该认识
 * (那会造成 store↔flywheel 双向依赖)。接线层调 `setOnRunTerminal` 注册, 默认不装 → 行为不变。
 */
export type RunTerminalHook = (rec: RunRecord) => Promise<void> | void;

let onRunTerminal: RunTerminalHook | null = null;

export function setOnRunTerminal(hook: RunTerminalHook | null): void {
  onRunTerminal = hook;
}

export function getOnRunTerminal(): RunTerminalHook | null {
  return onRunTerminal;
}

/**
 * 孤儿对账: 启动时把 pid 已死的 running 记录改判 interrupted。
 * 不做这一层的话, 重载后 UI/CLI 会显示"还在跑"的幽灵运行 —— 那是最典型的假状态。
 * 单条写失败不影响其它记录 (但会留降级痕迹): 对账本身不能因为一条坏记录而整体放弃。
 */
export async function reconcileOrphans(): Promise<{ interrupted: string[]; stillRunning: string[]; failed: string[] }> {
  const running = await listRuns({ status: 'running' });
  const interrupted: string[] = [];
  const stillRunning: string[] = [];
  const failed: string[] = [];
  for (const r of running) {
    if (pidAlive(r.pid)) { stillRunning.push(r.runId); continue; }
    try {
      const closed = await finishRun(r.runId, {
        status: 'interrupted',
        error: `进程 ${r.pid} 已不在 (刷新/重载/崩溃); 运行到此中断`,
      });
      interrupted.push(r.runId);
      // 终止路径进唯一责任链 (拿不到 Goal 就不收, 不假装收过)
      if (onRunTerminal) await Promise.resolve(onRunTerminal(closed || r)).catch(() => null);
    } catch (err) {
      failed.push(r.runId);
      await recordDegradation({ kind: 'core', op: 'reconcileOrphans', runId: r.runId, message: String((err as Error)?.message || err).slice(0, 200) });
    }
  }
  return { interrupted, stillRunning, failed };
}

/**
 * 失速巡检: running 且 updatedAt 超过 staleMs 没动 → 标 stalled。
 * 只标状态不改步骤 (事实层): 让 UI 能说"这个运行卡住了", 而不是永远转圈。
 */
export async function superviseRuns(now = Date.now()): Promise<{ stalled: string[]; failed: string[] }> {
  const cfg = await readHarnessConfig();
  const running = await listRuns({ status: 'running' });
  const stalled: string[] = [];
  const failed: string[] = [];
  for (const r of running) {
    if (!pidAlive(r.pid)) continue; // 交给 reconcileOrphans
    if (now - Date.parse(r.updatedAt) > cfg.staleMs) {
      try {
        const closed = await finishRun(r.runId, {
          status: 'stalled',
          error: `超过 ${Math.round(cfg.staleMs / 1000)}s 没有新进展 (可能是工具卡住或模型长时间无响应)`,
        });
        stalled.push(r.runId);
        // 同上: 失速也是一条终止路径
        if (onRunTerminal) await Promise.resolve(onRunTerminal(closed || r)).catch(() => null);
      } catch (err) {
        failed.push(r.runId);
        await recordDegradation({ kind: 'core', op: 'superviseRuns', runId: r.runId, message: String((err as Error)?.message || err).slice(0, 200) });
      }
    }
  }
  return { stalled, failed };
}

/** 给 CLI / GUI 的一行摘要 */
export function formatRunLine(r: RunRecord): string {
  const ago = Math.max(0, Math.round((Date.now() - Date.parse(r.updatedAt)) / 1000));
  const age = ago < 60 ? `${ago}s 前` : ago < 3600 ? `${Math.round(ago / 60)}m 前` : `${Math.round(ago / 3600)}h 前`;
  return `${r.runId}  [${r.surface}] ${r.status.padEnd(11)} steps=${String(r.steps.length).padStart(2)}  ${age}  ${r.goal.slice(0, 48)}`;
}

/** 测试用: 同步读 (避免 vitest 里额外的 await 噪音) */
export function readRunSync(runId: string): RunRecord | null {
  try {
    return JSON.parse(fssync.readFileSync(runPath(runId), 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-16 (Milestone 2): 恢复 —— prepareResume / 重放守卫 / 恢复指令
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 只读/幂等工具白名单。**不在此列一律按"非幂等"保守处理** —— 宁可少重放一次, 也不重复一条副作用。
 */
export const IDEMPOTENT_TOOLS = new Set([
  'read_file', 'read_document', 'list_files', 'glob_files', 'grep_files', 'find_files',
  'summarize_document', 'improve_document', 'get_tool_list', 'list_context_layers',
  'read_context_assets', 'list_plans', 'list_skills', 'list_goals', 'list_runs', 'list_questions',
  'git_status', 'git_log', 'git_diff', 'git_branch', 'git_show',
  'ipfs_cat', 'ipfs_ls', 'ipns_resolve', 'list_pending_friend_requests', 'list_peers',
  'go_to_definition', 'find_references', 'hover_info', 'code_completion', 'diagnostics', 'workspace_symbol',
  'browser', 'computer_use', 'clarify', 'x402_info_list', 'x402_info_verify', 'kanban_list', 'kanban_get',
  'list_skill_candidates', 'mcp_list_tools', 'list_decisions', 'trajectory_list',
]);

export function isNonIdempotentTool(tool: string): boolean {
  return !IDEMPOTENT_TOOLS.has(String(tool || ''));
}

/**
 * 可恢复的状态 (failed/done/aborted 是终态: 不从这里"复活")。
 * `recovering` 也算可恢复: 认领过的 run 允许"继续/重申领"(幂等) —— 否则 prepareResume 之后的
 * resumeRun 会被自己刚写下的 recovering 挡住。
 * ⚠️ 已知缺口 (归 Supervisor 批次): 还没有 lease, 两个进程可能同时重申领同一个 run。
 */
export const RESUMABLE_STATUSES: RunStatus[] = ['recovering', 'interrupted', 'stalled', 'paused', 'needs_human', 'awaiting_external'];

export interface ResumePlan {
  run: RunRecord;
  checkpoint?: RunCheckpoint;
  completedSteps: RunStep[];
  lastStep?: RunStep;
  /** 恢复后的入口动作 (来自 checkpoint.nextAction) */
  nextAction: string;
  /** 已成功执行过的**非幂等**动作 → 恢复时禁止重放, 直接复用当时结果 */
  replayGuards: { tool: string; argsDigest?: string; summary: string }[];
  objective?: string;
  goalId?: string;
}

/**
 * 准备恢复: 校验状态 → 读 checkpoint → 生成计划 → 落状态 recovering + 记一次 recovery attempt。
 * **不执行任何工具**: 执行由 pi-sdk 用 plan 继续 (同一 runId, 历史保留)。
 */
export async function prepareResume(runId: string): Promise<{ ok: boolean; reason?: string; plan?: ResumePlan }> {
  const rec = await readRun(runId);
  if (!rec) return { ok: false, reason: `run 不存在: ${runId}` };
  if (!RESUMABLE_STATUSES.includes(rec.status)) {
    return { ok: false, reason: `状态 ${rec.status} 不可恢复 (可恢复: ${RESUMABLE_STATUSES.join('/')})` };
  }

  const plan = await buildPlanFromRecord(rec);

  // 抢占归属 + 状态机: resumed run 归当前进程 (否则启动对账会把它再判成 interrupted)
  const claimed = await withRunLock(runId, () => coreWrite('prepareResume', runId, async () => {
    const cur = await readRun(runId);
    if (!cur) return null;
    if (!canTransition(cur.status, 'recovering')) return null;   // 期间被别的路径改了状态 → 放弃
    cur.status = 'recovering';
    cur.pid = process.pid;
    cur.host = os.hostname();
    cur.updatedAt = new Date().toISOString();
    await writeRun(cur);
    return cur;
  }));
  if (!claimed) return { ok: false, reason: `状态已被其它路径改变, 恢复未开始: ${runId}` };

  await recordRecovery(runId, {
    errorClass: (rec.errorClass as ErrorClass) || 'crash',
    message: `从 checkpoint 恢复 (已完成 ${plan.completedSteps.length} 步, 非幂等守卫 ${plan.replayGuards.length} 条)`,
    action: 'resume',
    checkpointBefore: rec.steps.length,
    changedPlan: rec.steps.length > 0,
  });

  return { ok: true, plan };
}

/**
 * 2026-09-16 (M2-B): **只读**为一个新 Run 生成"继续同一 Goal"的计划 (Supervisor 跨预算续跑用)。
 * 不改状态、不抢归属 —— 与 prepareResume 的区别是: 这条 Run 已经结束了, 我们要开下一条。
 */
export async function buildContinuationPlan(prevRunId: string): Promise<ResumePlan | null> {
  const rec = await readRun(prevRunId);
  if (!rec) return null;
  return buildPlanFromRecord(rec);
}

/** 计划构造的唯一实现 (resume 与 continuation 共用, 避免两套语义漂移) */
async function buildPlanFromRecord(rec: RunRecord): Promise<ResumePlan> {
  const completedSteps = rec.steps.filter((s) => s.ok);
  const replayGuards = rec.steps
    .filter((s) => s.ok && isNonIdempotentTool(s.tool))
    .map((s) => ({ tool: s.tool, argsDigest: s.argsDigest, summary: s.summary || '(已执行)' }));

  let objective: string | undefined;
  const goalId = rec.goalId;
  if (goalId) {
    try {
      const { readGoal } = await import('./goal-store.js');
      const g = await readGoal(goalId);
      objective = g?.objective;
    } catch { /* goal-store 不可用不影响恢复 */ }
  }

  // nextAction 要能直接指路 (恢复指令的核心): 上一步成功 → 别重做, 收尾确认; 上一步失败 → 先处理失败
  const last = rec.steps[rec.steps.length - 1];
  const defaultNext = last
    ? (last.ok
      ? `上一步 ${last.tool} 已成功; 如果目标已达成, 直接给出结论与证据并收尾 (不要重复已完成的动作)`
      : `上一步 ${last.tool} 失败 (${String(last.error || '未知').slice(0, 100)}); 先处理这个失败再继续目标`)
    : '继续未完成的目标 (先读最近失败步骤, 不要重复已成功的动作)';

  return {
    run: rec,
    checkpoint: rec.checkpoint,
    completedSteps,
    lastStep: last,
    nextAction: rec.checkpoint?.nextAction && !/由这一步的结果决定/.test(rec.checkpoint.nextAction)
      ? rec.checkpoint.nextAction
      : defaultNext,
    replayGuards,
    objective,
    goalId,
  };
}

/** 恢复真正开始执行时: recovering → running */
export async function markRunRunning(runId: string): Promise<boolean> {
  const res = await setRunStatus(runId, 'running');
  return !!res.ok;
}

/**
 * 生成恢复指令 (代替"重新发一遍原 prompt")。
 * 关键: 明确列出已完成动作 + 非幂等守卫 + 下一步, 让 agent 从 checkpoint 继续而不是从头再来。
 */
export function buildResumeInstruction(plan: ResumePlan): string {
  const lines: string[] = [];
  lines.push('[从 checkpoint 恢复] 这是一次**中断后恢复**的运行, 不是新任务。');
  if (plan.objective) lines.push(`目标: ${plan.objective}`);
  else lines.push(`目标: ${plan.run.goal}`);
  lines.push(`已完成 ${plan.completedSteps.length} 步 (不要重复执行它们):`);
  for (const s of plan.completedSteps.slice(-12)) {
    lines.push(`  ✓ ${s.n}. ${s.tool}${s.summary ? ` — ${s.summary.slice(0, 80)}` : ''}`);
  }
  if (plan.lastStep && !plan.lastStep.ok) {
    lines.push(`最近一步失败: ${plan.lastStep.tool} — ${plan.lastStep.error || '未知错误'}`);
  }
  if (plan.replayGuards.length) {
    lines.push('以下**非幂等**动作此前已经成功执行, 绝对不要重复执行 (否则会产生重复副作用):');
    for (const g of plan.replayGuards.slice(-10)) lines.push(`  ⛔ ${g.tool} — ${g.summary.slice(0, 80)}`);
  }
  lines.push(`下一步: ${plan.nextAction}`);
  lines.push('请直接从中断处继续完成任务; 完成后按正常格式给出结论与证据。');
  return lines.join('\n');
}
