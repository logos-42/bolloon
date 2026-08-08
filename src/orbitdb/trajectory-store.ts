/**
 * trajectory-store.ts — 智能体运行轨迹 (trajectory) 记录 (2026-08-08)
 *
 * 用户需求: "把 bolloon agent 运行过程产生的轨迹保存进 orbitdb. 智能体运行的轨迹也可以落盘."
 *
 * 双层持久化:
 *   1. 落盘: ~/.bolloon/trajectories/<runId>.json (审计/离线可读)
 *   2. OrbitDB: keyvalue store `bolloon-trajectories-<did>`, key=runId
 *      (与 bolloon-cid-store 共享 helia/OrbitDB 实例; 跨设备复制 + 内容寻址)
 *
 * 轨迹内容: 一轮运行 (用户输入 → 事件/工具调用步骤 → AI 回复) 的完整回放.
 * 失败静默: recorder 是增强层, 任何持久化失败都不影响 agent 主流程.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getCIDDatabase, type CIDDatabase } from './cid-database.js';
import { didDirName } from '../storage/did-catalog.js';

const homeRoot = (h?: string): string => h || process.env.HOME || os.homedir() || '/tmp';

export type TrajectoryStepStatus = 'ok' | 'error' | 'info';

/** 单步轨迹: 工具调用 / 状态事件 / 错误 */
export interface TrajectoryStep {
  /** 工具名或事件类型 (tool/status/error/thinking/phase...) */
  name: string;
  kind: 'tool' | 'status' | 'error' | 'thinking' | 'phase' | 'done';
  content: string;
  ts: number;
  /** 工具调用耗时 (ms, 可选) */
  durMs?: number;
}

/** 轨迹里的消息 (输入/回复, 可选带历史) */
export interface TrajectoryMessage {
  role: string;
  content: string;
  ts: number;
}

/** 一轮完整运行轨迹 */
export interface TrajectoryRun {
  runId: string;
  did?: string;
  agentId: string;
  channelId?: string;
  input: string;
  reply: string;
  status: 'ok' | 'error' | 'aborted';
  model?: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  steps: TrajectoryStep[];
  messages: TrajectoryMessage[];
}

export interface TrajectoryOpts {
  home?: string;
  /** 注入 CID 数据库 (测试假实现 / 关闭 OrbitDB) */
  db?: CIDDatabase | null;
  /** 是否同时写 OrbitDB (默认 true; 无 did 自动跳过) */
  orbit?: boolean;
}

export function newRunId(agentId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}__${String(agentId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`;
}

function trajectoriesDir(home?: string): string {
  return path.join(homeRoot(home), '.bolloon', 'trajectories');
}

/** 1. 落盘: ~/.bolloon/trajectories/<runId>.json */
export async function saveTrajectoryToDisk(run: TrajectoryRun, home?: string): Promise<string> {
  const dir = trajectoriesDir(home);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${run.runId}.json`);
  await fs.writeFile(file, JSON.stringify(run, null, 2), 'utf-8');
  return file;
}

function trajectoryStoreName(did: string): string {
  return `bolloon-trajectories-${didDirName(did)}`;
}

/** 2. OrbitDB: keyvalue store `bolloon-trajectories-<did>`, key=runId */
export async function saveTrajectoryToOrbit(
  run: TrajectoryRun,
  opts: TrajectoryOpts = {},
): Promise<boolean> {
  try {
    const did = run.did;
    if (!did) return false;
    if (opts.orbit === false) return false;
    const db: CIDDatabase | null = opts.db !== undefined ? opts.db : getCIDDatabase();
    if (!db) return false;
    const store = await db.openStore(trajectoryStoreName(did), 'keyvalue');
    await store.put(run.runId, run);
    return true;
  } catch {
    return false;
  }
}

/** 一步到位: 落盘 + OrbitDB (各自失败静默, 返回落盘路径) */
export async function recordTrajectory(run: TrajectoryRun, opts: TrajectoryOpts = {}): Promise<string | null> {
  let file: string | null = null;
  try {
    file = await saveTrajectoryToDisk(run, opts.home);
  } catch { /* 落盘失败静默 */ }
  await saveTrajectoryToOrbit(run, opts).catch(() => false);
  return file;
}

/** 列出一轮轨迹 (文件名 → runId, 新→旧) */
export async function listTrajectories(home?: string, limit = 50): Promise<Array<{ runId: string; file: string }>> {
  try {
    const dir = trajectoriesDir(home);
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort().reverse().slice(0, limit);
    return files.map(f => ({ runId: f.replace(/\.json$/, ''), file: path.join(dir, f) }));
  } catch {
    return [];
  }
}

/** 读一轮轨迹 */
export async function loadTrajectory(runId: string, home?: string): Promise<TrajectoryRun | null> {
  try {
    const raw = await fs.readFile(path.join(trajectoriesDir(home), `${runId}.json`), 'utf-8');
    return JSON.parse(raw) as TrajectoryRun;
  } catch {
    return null;
  }
}

/** 内存版 recorder: 采集步骤/消息, endRun 时产出 TrajectoryRun (持久化交给 recordTrajectory) */
export class TrajectoryRecorder {
  readonly runId: string;
  readonly agentId: string;
  readonly channelId?: string;
  readonly did?: string;
  readonly input: string;
  readonly startedAt: number;
  readonly model?: string;
  private steps: TrajectoryStep[] = [];
  private messages: TrajectoryMessage[] = [];
  private ended = false;

  constructor(opts: {
    agentId: string;
    input: string;
    channelId?: string;
    did?: string;
    model?: string;
    runId?: string;
  }) {
    this.runId = opts.runId || newRunId(opts.agentId);
    this.agentId = opts.agentId;
    this.channelId = opts.channelId;
    this.did = opts.did;
    this.input = opts.input;
    this.model = opts.model;
    this.startedAt = Date.now();
  }

  /** 记录一个流事件 (tool/status/error/thinking/phase/done) */
  recordStep(ev: { type?: string; content?: unknown; tool?: string }): void {
    if (this.ended) return;
    const type = String(ev.type || 'status');
    const kind = (['tool', 'status', 'error', 'thinking', 'phase', 'done'].includes(type) ? type : 'status') as TrajectoryStep['kind'];
    const name = kind === 'tool' ? String(ev.tool || 'tool') : kind;
    const content = typeof ev.content === 'string' ? ev.content : '';
    // 同类型连续状态压缩 (防步骤爆炸): 只保留 content 变化的
    const last = this.steps[this.steps.length - 1];
    if (last && last.name === name && last.kind === kind && last.content === content) return;
    this.steps.push({ name, kind, content: content.slice(0, 2000), ts: Date.now() });
  }

  /** 记录一条消息 (输入/中间/回复) */
  recordMessage(role: string, content: string): void {
    if (this.ended) return;
    this.messages.push({ role, content: content.slice(0, 8000), ts: Date.now() });
  }

  /** 结束一轮 → 产出 TrajectoryRun (不可再 record) */
  endRun(reply: string, status: 'ok' | 'error' | 'aborted' = 'ok'): TrajectoryRun {
    this.ended = true;
    const endedAt = Date.now();
    return {
      runId: this.runId,
      did: this.did,
      agentId: this.agentId,
      channelId: this.channelId,
      input: this.input,
      reply,
      status,
      model: this.model,
      startedAt: this.startedAt,
      endedAt,
      durationMs: endedAt - this.startedAt,
      steps: this.steps,
      messages: this.messages,
    };
  }

  get stepCount(): number { return this.steps.length; }
}
