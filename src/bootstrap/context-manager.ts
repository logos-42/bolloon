/**
 * context-manager.ts — Context OS 资源管理器 (2026-08-06)
 *
 * 把"上下文压缩"升级为资源管理系统:
 *   Token Budget → Monitor → Event → Compression Worker → Snapshot → Memory → UI 反馈
 *
 * 配置 (env 可覆盖):
 *   MAX_CONTEXT_TOKENS    默认 1_000_000 (1M tokens 全局窗口)
 *   COMPRESSION_THRESHOLD 默认 0.55 (55% 自动压缩)
 *   WARNING_THRESHOLD     默认 0.50 (50% 状态栏 warning)
 *
 * 生命周期:
 *   < 50%  normal
 *   50-55% warning (UI 提示即将压缩)
 *   >= 55% auto compression (触发后生成 summary + snapshot, 替换历史)
 *
 * 设计:
 *   - 纯模块, 不 import pi-sdk (避免循环依赖); 只依赖 context-compaction 的 token 估算
 *   - 事件订阅: CLI / Web UI / Logger 各自订阅, 压缩状态实时可见
 *   - Snapshot 落盘 ~/.bolloon/context-os/snapshots/ (JSON), 可选 CID 化 (ContextStore)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

// ============================================================
// 配置
// ============================================================

export interface ContextConfig {
  /** 全局上下文窗口 (tokens), 默认 1M */
  maxTokens: number;
  /** 自动压缩阈值 (0-1), 默认 0.55 */
  compressionThreshold: number;
  /** warning 阈值 (0-1), 默认 0.50 */
  warningThreshold: number;
}

export function getContextConfig(env: NodeJS.ProcessEnv = process.env): ContextConfig {
  const num = (v: string | undefined, def: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const maxTokens = num(env.MAX_CONTEXT_TOKENS, 1_000_000);
  const compressionThreshold = Math.min(1, Math.max(0, num(env.COMPRESSION_THRESHOLD, 0.55)));
  const warningThreshold = Math.min(compressionThreshold, Math.max(0, num(env.WARNING_THRESHOLD, 0.5)));
  return { maxTokens, compressionThreshold, warningThreshold };
}

// ============================================================
// Usage
// ============================================================

export type ContextStage = 'normal' | 'warning' | 'compressing' | 'compressed';

export interface ContextUsage {
  /** 当前已用 tokens */
  usedTokens: number;
  /** 窗口上限 tokens */
  maxTokens: number;
  /** 使用率 0-1 */
  pct: number;
  /** 阶段: normal / warning / compressing / compressed */
  stage: ContextStage;
  /** 上次压缩时间戳 (ms), 0 = 从未压缩 */
  lastCompressedAt: number;
  /** 上次压缩保存的 tokens */
  lastSavedTokens: number;
}

export function usageFromTokens(
  usedTokens: number,
  config: ContextConfig,
  lastCompressedAt = 0,
  lastSavedTokens = 0
): ContextUsage {
  const pct = config.maxTokens > 0 ? usedTokens / config.maxTokens : 0;
  let stage: ContextStage = 'normal';
  if (usedTokens >= config.maxTokens * config.compressionThreshold) stage = 'compressing';
  else if (usedTokens >= config.maxTokens * config.warningThreshold) stage = 'warning';
  if (lastCompressedAt > 0 && stage === 'normal') stage = 'compressed';
  return { usedTokens, maxTokens: config.maxTokens, pct, stage, lastCompressedAt, lastSavedTokens };
}

// ============================================================
// Snapshot
// ============================================================

export interface ContextSnapshot {
  /** 快照 id (uuid) */
  id: string;
  /** CID (ContextStore.saveSnapshot 返回, 可选) */
  cid?: string;
  /** 压缩发生时间 */
  timestamp: number;
  /** 压缩前 tokens */
  beforeTokens: number;
  /** 压缩后 tokens */
  afterTokens: number;
  /** LLM 生成的摘要 (或模板) */
  summary: string;
  /** 保留的关键记忆条目 */
  preservedMemory: string[];
  agentId?: string;
  channelId?: string;
}

export function getSnapshotsDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'context-os', 'snapshots');
}

/** 持久化 snapshot 到磁盘 (JSON 文件, 供恢复/调试). 失败静默. */
export async function saveSnapshotToDisk(snap: ContextSnapshot, home?: string): Promise<string | null> {
  try {
    const dir = getSnapshotsDir(home);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${snap.timestamp}-${snap.id.slice(0, 8)}.json`);
    await fs.writeFile(file, JSON.stringify(snap, null, 2), 'utf-8');
    return file;
  } catch {
    return null;
  }
}

/** 读取最近一次 snapshot (按时间戳). 无 → null. */
export async function loadLatestSnapshot(home?: string): Promise<ContextSnapshot | null> {
  try {
    const dir = getSnapshotsDir(home);
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) return null;
    const raw = await fs.readFile(path.join(dir, files[files.length - 1]), 'utf-8');
    return JSON.parse(raw) as ContextSnapshot;
  } catch {
    return null;
  }
}

// ============================================================
// 事件
// ============================================================

export type ContextEvent =
  | { type: 'context.warning'; usage: ContextUsage }
  | { type: 'context.compress.start'; beforeTokens: number; thresholdTokens: number }
  | { type: 'context.compress.complete'; snapshot: ContextSnapshot; usage: ContextUsage }
  | { type: 'context.snapshot.created'; snapshot: ContextSnapshot };

type ContextEventHandler = (evt: ContextEvent) => void;

// ============================================================
// ContextManager (单例)
// ============================================================

export class ContextManager {
  private config: ContextConfig;
  private listeners = new Set<ContextEventHandler>();
  private _usage: ContextUsage;

  constructor(config: ContextConfig = getContextConfig()) {
    this.config = config;
    this._usage = usageFromTokens(0, config);
  }

  getConfig(): ContextConfig {
    return this.config;
  }

  /** 重载配置 (env 变化/测试用) */
  reloadConfig(env?: NodeJS.ProcessEnv): void {
    this.config = getContextConfig(env);
  }

  getUsage(): ContextUsage {
    return this._usage;
  }

  /** 更新当前 token 用量 (由 pi-sdk 每轮 LLM 调用前报告). 返回 stage 是否变化. */
  updateUsage(usedTokens: number): ContextUsage {
    const next = usageFromTokens(usedTokens, this.config, this._usage.lastCompressedAt, this._usage.lastSavedTokens);
    const prevStage = this._usage.stage;
    this._usage = next;
    // warning 边界: normal → warning 时发一次 (不重复发)
    if (prevStage !== 'warning' && next.stage === 'warning') {
      this.emit({ type: 'context.warning', usage: next });
    }
    return next;
  }

  /** 压缩开始: 记录 before, 发事件, 返回 threshold 供日志. */
  markCompressStart(beforeTokens: number): number {
    const thresholdTokens = Math.round(this.config.maxTokens * this.config.compressionThreshold);
    this._usage = { ...this._usage, stage: 'compressing' };
    this.emit({ type: 'context.compress.start', beforeTokens, thresholdTokens });
    return thresholdTokens;
  }

  /** 压缩完成: 记录 after + snapshot, 发事件. */
  markCompressComplete(snap: ContextSnapshot): void {
    this._usage = {
      usedTokens: snap.afterTokens,
      maxTokens: this.config.maxTokens,
      pct: snap.afterTokens / this.config.maxTokens,
      stage: 'compressed',
      lastCompressedAt: snap.timestamp,
      lastSavedTokens: Math.max(0, snap.beforeTokens - snap.afterTokens),
    };
    this.emit({ type: 'context.compress.complete', snapshot: snap, usage: this._usage });
    this.emit({ type: 'context.snapshot.created', snapshot: snap });
    saveSnapshotToDisk(snap).catch(() => {});
  }

  /** 订阅事件. 返回取消函数. */
  onEvent(handler: ContextEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private emit(evt: ContextEvent): void {
    for (const h of this.listeners) {
      try { h(evt); } catch { /* 单个订阅者失败不影响其余 */ }
    }
  }

  /** 创建 snapshot 对象 (不含 CID, 由调用方决定是否 CID 化) */
  makeSnapshot(opts: {
    beforeTokens: number;
    afterTokens: number;
    summary: string;
    preservedMemory?: string[];
    agentId?: string;
    channelId?: string;
  }): ContextSnapshot {
    return {
      id: randomUUID(),
      timestamp: Date.now(),
      beforeTokens: opts.beforeTokens,
      afterTokens: opts.afterTokens,
      summary: opts.summary,
      preservedMemory: opts.preservedMemory ?? [],
      agentId: opts.agentId,
      channelId: opts.channelId,
    };
  }
}

let _manager: ContextManager | null = null;
export function getContextManager(): ContextManager {
  if (!_manager) _manager = new ContextManager();
  return _manager;
}

/** 测试钩子: 重置单例 */
export function _resetContextManagerForTest(): void {
  _manager = null;
}
