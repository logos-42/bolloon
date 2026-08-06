/**
 * context-store.ts — Context OS 的 CID 化适配层 (2026-08-06)
 *
 * 在现有 Context OS 文件夹体系之上叠加 CID 快照/版本/共享能力 (不动原实现):
 *   - saveSnapshot: 抓取当前资产层 (readContextAssets) → 存 CIDDatabase (type: 'context')
 *   - restoreContext: 按 agentId 恢复最近快照
 *   - contextVersions: 快照版本历史
 *   - sharedMemory: 多 agent 共享记忆 (type: 'memory' 记录跨 agent 可见)
 *
 * 架构: Agent → ContextStore → CIDDatabase → OrbitDB → CID → IPFS
 */

import {
  getCIDDatabase,
  type CIDDatabase,
  type CIDRecord,
} from './cid-database.js';
import { readContextAssets } from '../bootstrap/context-os.js';

export interface ContextSnapshot {
  agentId: string;
  layers: Record<string, string[]>;
  memorySummary?: string;
  focus?: string;
  capturedAt: number;
}

/** 快照 → 可用于恢复的上下文文本 (注入 prompt 用) */
export function formatSnapshot(s: ContextSnapshot): string {
  const lines: string[] = [`[Context 快照 @${new Date(s.capturedAt).toISOString()}]`];
  for (const [layer, assets] of Object.entries(s.layers)) {
    if (assets.length) lines.push(`  ${layer}: ${assets.join(', ')}`);
  }
  if (s.memorySummary) lines.push(`  记忆: ${s.memorySummary.slice(0, 200)}`);
  if (s.focus) lines.push(`  focus: ${s.focus}`);
  return lines.join('\n');
}

export class ContextStore {
  constructor(private db: CIDDatabase = getCIDDatabase()) {}

  /** 抓取当前 Context OS 资产层 → 快照 (与现有 readContextAssets 打通) */
  async captureCurrentContext(agentId: string, extra?: { memorySummary?: string; focus?: string }): Promise<ContextSnapshot> {
    const layers: Record<string, string[]> = {};
    try {
      const listings = await readContextAssets();
      for (const l of listings) {
        layers[l.layer] = (l.files ?? []).map(a => a.file);
      }
    } catch {
      /* 资产层读取失败不阻塞快照 */
    }
    return {
      agentId,
      layers,
      memorySummary: extra?.memorySummary,
      focus: extra?.focus,
      capturedAt: Date.now(),
    };
  }

  /** 保存快照 → CID 记录 (type: 'context') */
  async saveSnapshot(snapshot: ContextSnapshot): Promise<CIDRecord> {
    return this.db.save({
      agentId: snapshot.agentId,
      type: 'context',
      content: snapshot,
      metadata: { kind: 'context-snapshot' },
    });
  }

  /** 恢复: agentId 最近一次快照 */
  async restoreContext(agentId: string): Promise<ContextSnapshot | null> {
    const snaps = await this.db.list({ agentId, type: 'context' });
    const latest = snaps[snaps.length - 1];
    return latest ? (latest.content as ContextSnapshot) : null;
  }

  /** 快照版本历史 (全量, 从旧到新) */
  async contextVersions(agentId: string): Promise<CIDRecord[]> {
    return this.db.list({ agentId, type: 'context' });
  }

  /** 多 agent 共享记忆: 全部 memory 记录 (跨 agent 可见), 可指定 agentId */
  async sharedMemory(agentId?: string): Promise<CIDRecord[]> {
    return this.db.list(agentId ? { agentId, type: 'memory' } : { type: 'memory' });
  }

  /** 保存一条记忆 (多 agent 共享池) */
  async saveMemory(agentId: string, content: unknown, metadata?: Record<string, unknown>): Promise<CIDRecord> {
    return this.db.save({ agentId, type: 'memory', content, metadata: { ...metadata, kind: 'shared-memory' } });
  }

  /** 按 CID 恢复任意记录 (含跨节点分享的) */
  async loadRecord(cid: string): Promise<CIDRecord | null> {
    return this.db.load(cid);
  }
}

/** 单例 */
let _contextStore: ContextStore | null = null;
export function getContextStore(): ContextStore {
  if (!_contextStore) _contextStore = new ContextStore();
  return _contextStore;
}
