/**
 * memory-sync.ts — 记忆条目级 OrbitDB 复制 (P3, decentralized-memory-design §2.6)
 *
 * 在现有 CID 快照(整快照)之上加「条目级同步」:
 *   - 保存: MemoryEntry.id (sha256) 作为经内容寻址的 key
 *   - 存储: CIDDatabase type='memory', metadata 带 entryId + entryUpdatedAt
 *   - 复制: OrbitDB pubsub 自动 (既有机制)
 *   - 冲突: 同 entryId 冲突 → updatedAt 大者胜 (LWW), 平手比 content hash
 *
 * 诚实边界 (写死):
 *   - 条目级复制依赖 OrbitDB 网络就绪 (getCIDDatabase 初始化); 网络不可用 /
 *     初始化失败 → 静默跳过 (本地记忆仍是权威, 复制是增强不是阻塞)
 *   - 本模块不建新 store, 复用既有 bolloon-cid-store (type='memory')
 *   - 跨机器真同步需双节点 (设计文档 §5 已记「跨机读群未验证」, P3 只保证
 *     条目可被 CID 化 + 可恢复; 真双节点验证是 P3b)
 */
import { getCIDDatabase, type CIDDatabase, type CIDRecord } from './cid-database.js';
import type { MemoryEntry } from '../agents/memory-store.js';

/** 条目 → CID 记录的 metadata 常量键 */
const META_ENTRY_ID = 'entryId';
const META_ENTRY_UPDATED = 'entryUpdatedAt';

/** 从 CID 记录还原 MemoryEntry (metadata 无 entryId 的旧记录 → null) */
export function entryFromRecord(rec: CIDRecord | null): MemoryEntry | null {
  if (!rec) return null;
  const meta = rec.metadata || {};
  if (!meta[META_ENTRY_ID]) return null;
  const e = rec.content as MemoryEntry;
  if (!e || typeof e !== 'object' || !e.id || !e.agentId) return null;
  return e;
}

/**
 * 同步入口: 把一条 MemoryEntry 写入 OrbitDB (条目级)。
 * 失败静默 (本地记忆不受影响), 返回 CID 或 null。
 */
export async function syncMemoryEntryToOrbit(
  entry: MemoryEntry,
  db: CIDDatabase = getCIDDatabase(),
): Promise<string | null> {
  try {
    const rec = await db.save({
      agentId: entry.agentId,
      type: 'memory',
      content: entry,
      metadata: {
        [META_ENTRY_ID]: entry.id,
        [META_ENTRY_UPDATED]: entry.updatedAt,
        kind: 'memory-entry',
      },
    });
    return rec.id;
  } catch {
    return null; // 网络/初始化失败静默 — 本地记忆仍权威
  }
}

/**
 * 拉取远端条目: 列出该 agent 的全部 memory type 记录, 还原成 MemoryEntry。
 * 仅返回「本地没有 或 远端 updatedAt 更新」的条目 (LWW)。
 * 不写本地 — 由调用方决定如何合并。
 */
export async function fetchRemoteEntries(
  agentId: string,
  db: CIDDatabase = getCIDDatabase(),
): Promise<MemoryEntry[]> {
  try {
    const recs = await db.list({ agentId, type: 'memory' });
    return recs
      .map((r) => entryFromRecord(r))
      .filter((e): e is MemoryEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * LWW 合并决策: 远端条目 vs 本地条目, 谁胜。
 *   - 本地无 → 远端胜
 *   - 远端 updatedAt > 本地 → 远端胜
 *   - 远端 updatedAt ≤ 本地 → 本地胜 (平手比内容不算, 直接本地胜, LWW)
 */
export function shouldTakeRemote(remote: MemoryEntry, local: MemoryEntry | undefined): boolean {
  if (!local) return true;
  return remote.updatedAt > local.updatedAt;
}

/** 合并远端条目到本地 Map (就地更新), 返回被采纳的远端条数 (LWW) */
export function mergeRemoteEntries(
  local: Map<string, MemoryEntry>,
  remote: MemoryEntry[],
): number {
  let n = 0;
  for (const r of remote) {
    const l = local.get(r.id);
    if (shouldTakeRemote(r, l)) {
      local.set(r.id, r);
      n++;
    }
  }
  return n;
}