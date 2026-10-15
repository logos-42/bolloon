/**
 * memory-node-child.ts — 真两节点记忆复制验收的**子进程** (2026-10-15, P3b)
 *
 * 为什么必须子进程: `getCIDDatabase()` 是**进程内单例** (一个 helia/OrbitDB 节点),
 * 所以"两个真节点"只能是两个真进程。本子进程 = 一个节点 (自己的 HOME / 身份 / blockstore / 随机端口)。
 *
 * 用法:  <tsx> scripts/lib/memory-node-child.ts <spec.json>
 * stdout: 每阶段一行 `@@OUT {json}`; 便于父进程逐行解析。
 *
 * spec 形状:
 *   { home, phase, storeAddr?, addrs?, count?, waitFor?, timeoutMs?, pollMs?, holdMs? }
 * phase:
 *   create_and_send  建记忆 CID store (bolloon-cid-store) + 写入 count 条 MemoryEntry → 报 address/peerId/addrs
 *   join_and_wait    (可选 dial addrs) → 按地址打开同一 store → 等 seen >= waitFor → 报 seen/entriesHash/耗时
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { OrbitDBAdapter, type OrbitDBStore } from '../../src/orbitdb/cid-database.js';

interface Spec {
  home: string;
  phase: 'create_and_send' | 'join_and_wait';
  storeAddr?: string;
  addrs?: string[];
  count?: number;
  waitFor?: number;
  timeoutMs?: number;
  pollMs?: number;
  holdMs?: number;
}

const specPath = process.argv[2];
if (!specPath) { console.error('用法: memory-node-child.ts <spec.json>'); process.exit(2); }
const spec: Spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const dataDir = path.join(spec.home, '.bolloon', 'orbitdb');

function out(obj: Record<string, unknown>): void {
  process.stdout.write('@@OUT ' + JSON.stringify(obj) + '\n');
}

/** 记忆条目的集合指纹: 排序后的 entryId 列表做 sha256 — 两节点收敛 = 同一个 hash */
function entriesHash(entries: Array<{ id: string }>): { hash: string; seen: number } {
  const keys = entries.map((e) => e.id).sort();
  const h = crypto.createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
  return { hash: h, seen: entries.length };
}

/** 递归统计目录字节数 */
function diskBytes(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* 忽略 */ } }
    }
  };
  walk(dir);
  return total;
}

/** 从 OrbitDB store 读出所有 type='memory' 的记录 (value 是 CIDRecord) */
async function readMemoryRecords(store: OrbitDBStore): Promise<Array<{ id: string; agentId: string }>> {
  const all = (await store.all()) as unknown as Array<{ key: string; value: any }>;
  return all
    .map((e) => e.value)
    .filter((v: any) => v && typeof v === 'object' && v.type === 'memory' && v.content?.id)
    .map((v: any) => ({ id: String(v.content.id), agentId: String(v.content.agentId) }));
}

async function main(): Promise<void> {
  const db = new OrbitDBAdapter(dataDir);
  const base = { phase: spec.phase, home: spec.home, dataDir };
  const t0 = Date.now();

  try {
    if (spec.phase === 'create_and_send') {
      // 打开记忆 CID store (与 getCIDDatabase 同名单例: bolloon-cid-store)
      const store = await db.openStore('bolloon-cid-store', 'keyvalue');
      const n = spec.count ?? 0;
      const tSend = Date.now();
      for (let i = 0; i < n; i++) {
        const id = crypto.createHash('sha256').update(`agent-a|记忆条目-${i}`).digest('hex').slice(0, 32);
        const rec = {
          id,
          agentId: 'agent-a',
          timestamp: Date.now(),
          type: 'memory' as const,
          content: {
            id,
            agentId: 'agent-a',
            content: `记忆条目-${i}`,
            kind: 'fact',
            importance: 0.5,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            source: 'manual',
            refs: [],
            crystallized: false,
            recallCount: 0,
          },
          metadata: { entryId: id, entryUpdatedAt: new Date().toISOString(), kind: 'memory-entry' },
          version: 1,
        };
        await store.put(rec.id, JSON.parse(JSON.stringify(rec)));
      }
      const all = await readMemoryRecords(store);
      const hash = entriesHash(all);
      out({ ...base, ok: true, storeAddr: store.address, appended: n, sendMs: Date.now() - tSend,
            peerId: db.peerId, addrs: db.listenAddrs(), entriesHash: hash.hash, seen: hash.seen,
            diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
      // 供块的节点必须活着 (群门 2026-09-30 教训)
      const hold = spec.holdMs ?? 0;
      if (hold > 0) {
        out({ hold: true, holdMs: hold, phase: spec.phase, peerId: db.peerId, addrs: db.listenAddrs() });
        await new Promise((r) => setTimeout(r, hold));
      }
      await db.close();
      process.exit(0);
    }

    if (spec.phase === 'join_and_wait') {
      // 拨号重试 + 错误不吞 (群门纪律)
      const dialErrors: string[] = [];
      for (let attempt = 1; attempt <= 4; attempt++) {
        let ok = 0;
        for (const a of spec.addrs ?? []) {
          try { await db.dial(a); ok++; } catch (e) { dialErrors.push(`try${attempt} ${a.slice(-24)}: ${String((e as Error)?.message ?? e).slice(0, 80)}`); }
        }
        if (ok > 0) break;
        await new Promise((res) => setTimeout(res, 750 * attempt));
      }
      const store = await db.openStoreByAddress(spec.storeAddr!, 'keyvalue');
      if (!store) { out({ ...base, ok: false, error: 'openStoreByAddress 返回 null', dialErrors }); process.exit(1); }
      const want = spec.waitFor ?? 1;
      const tWait = Date.now();
      const deadline = Date.now() + (spec.timeoutMs ?? 60_000);
      let seen = 0;
      let lastError: string | null = null;
      let attempts = 0;
      let records: Array<{ id: string; agentId: string }> = [];
      while (Date.now() < deadline) {
        attempts++;
        try { records = await readMemoryRecords(store); seen = records.length; lastError = null; }
        catch (e) { lastError = String((e as Error)?.message ?? e).slice(0, 160); }
        if (seen >= want) break;
        await new Promise((res) => setTimeout(res, spec.pollMs ?? 500));
      }
      const hash = entriesHash(records);
      out({ ...base, ok: seen >= want, storeAddr: spec.storeAddr, seen, want, waitMs: Date.now() - tWait, polls: attempts,
            dialAttempts: spec.addrs?.length ?? 0, dialErrors: dialErrors.slice(0, 6), lastError,
            entriesHash: hash.hash, peerId: db.peerId, addrs: db.listenAddrs(),
            diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
      await db.close();
      process.exit(seen >= want ? 0 : 1);
    }

    out({ ...base, ok: false, error: `未知 phase: ${spec.phase}` });
    process.exit(2);
  } catch (err: any) {
    out({ ...base, ok: false, error: String(err?.message || err) });
    try { await db.close(); } catch { /* 已坏 */ }
    process.exit(1);
  }
}

main();