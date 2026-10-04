/**
 * group-node-child.ts — 真两节点复制验收的**子进程** (2026-09-30, P0)
 *
 * 为什么必须子进程: `getCIDDatabase()` 是**进程内单例** (一个 helia/OrbitDB 节点),
 * 所以"两个真节点"只能是两个真进程 —— 用 fake CIDDatabase 注入的那种测试
 * (src/test/gateway-group.test.ts 等 5 个文件) 从来验不到真复制。
 *
 * 用法:  <tsx> scripts/lib/group-node-child.ts <spec.json>
 * 一个进程 = 一个节点 (自己的 HOME / 身份 / blockstore / 随机端口)。
 * stdout: 每个阶段一行 `@@OUT {json}`; 便于父进程逐行解析。
 *
 * spec 形状:
 *   { home, phase, group?, address?, addrs?, dial?, count?, from?, waitFor?, timeoutMs?, pollMs?, sendWhileNotConnected? }
 * phase:
 *   create_and_send  建 events store (write:['*']) + 欢迎消息 + 追加 count 条 → 报 address/link/peerId/addrs
 *   join_and_wait    (可选 dial addrs) → 按地址打开 → 等 seen >= waitFor → 报 seen/keysHash/耗时/磁盘
 *   open_and_wait    同上, 但用于"自己创建的节点重启后回来" (不 dial 时只读本地)
 *   send_only        按地址打开 (不 dial) 后追加 count 条 → 证明成员离线也能写
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { OrbitDBAdapter, type OrbitDBStore } from '../../src/orbitdb/cid-database.js';
import { appendEvent, listShards, manifestStoreName, readTail, waitForManifest } from '../../src/orbitdb/group-shards.js';

interface Spec {
  home: string;
  phase: 'create_and_send' | 'join_and_wait' | 'open_and_wait' | 'send_only' | 'probe_sync' | 'shard_append' | 'shard_tail' | 'module_ops';
  /** module_ops 用: create(建群+发 count 条) | join_read(拨号入群→等齐→回写) | read_only(只按 groupId 读) */
  mode?: 'create' | 'join_read' | 'read_only';
  /** module_ops create 用: 群写入权限。缺省 = 创建者独占 (2026-10-01 P1 起的默认); 'open' = 谁拿链接都能发言 */
  acl?: 'open' | 'creator';
  link?: string;
  groupId?: string;
  group?: string;
  address?: string;
  addrs?: string[];
  dial?: boolean;
  count?: number;
  from?: string;
  waitFor?: number;
  timeoutMs?: number;
  pollMs?: number;
  /** 阶段完成后**保持节点在线**多久 (ms) —— 真两节点验收里, 供块的节点必须活着 */
  holdMs?: number;
  /** shard_append 用: 造多少个**不同身份** (actorId) 的事件 —— P5 压测要 N 个 agent 而不是 N 条同源消息 */
  distinctActors?: number;
}

const specPath = process.argv[2];
if (!specPath) { console.error('用法: group-node-child.ts <spec.json>'); process.exit(2); }
const spec: Spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const dataDir = path.join(spec.home, '.bolloon', 'orbitdb');

function out(obj: Record<string, unknown>): void {
  process.stdout.write('@@OUT ' + JSON.stringify(obj) + '\n');
}

/** 递归统计目录字节数 (P0 要量"本地占用") */
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

/** 事件流的集合指纹: 排序后的 key 列表做 sha256 —— 两节点收敛 = 同一个 hash */
async function keysHash(store: OrbitDBStore): Promise<{ hash: string; seen: number }> {
  const all = await store.all();
  const keys = all.map((r) => r.key).sort();
  const h = crypto.createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
  return { hash: h, seen: all.length };
}

async function waitForCount(store: OrbitDBStore, want: number, timeoutMs: number, pollMs: number) {
  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < timeoutMs) {
    seen = (await store.all()).length;
    if (seen >= want) return { seen, timedOut: false, waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { seen, timedOut: true, waitedMs: Date.now() - t0 };
}

/**
 * 阶段做完后按 spec.holdMs 保持在线 (默认 0 = 立刻退出)。
 * 2026-09-30 教训: 第一版阶段结束就 exit, 于是对端拨号得到 ECONNREFUSED、
 * 拉块得到 "Failed to load block" —— 看着像复制坏了, 其实是**供块的节点已经不在**。
 */
async function holdIfAsked(db: OrbitDBAdapter): Promise<void> {
  const ms = spec.holdMs ?? 0;
  if (ms <= 0) return;
  out({ hold: true, holdMs: ms, phase: spec.phase, home: spec.home, peerId: db.peerId, addrs: db.listenAddrs() });
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const db = new OrbitDBAdapter(dataDir);
  const base = { phase: spec.phase, home: spec.home, dataDir };
  const t0 = Date.now();

  try {
    if (spec.phase === 'create_and_send') {
      const group = spec.group || 'p0-group';
      const store = await db.openStore(`bolloon-gw-group-${group}`, 'events', { accessController: { write: ['*'] } });
      await store.add({ from: spec.from || 'A', text: `📢 群主创建了群「${group}」`, ts: Date.now() });
      const n = spec.count ?? 0;
      const tSend = Date.now();
      for (let i = 0; i < n; i++) {
        await store.add({ from: spec.from || 'A', text: `e${i}`, seq: i, ts: Date.now() });
      }
      const hash = await keysHash(store);
      out({ ...base, ok: true, address: store.address, link: `orbitdb://${store.address}?type=group&name=${group}`,
            appended: n + 1, sendMs: Date.now() - tSend, peerId: db.peerId, addrs: db.listenAddrs(),
            keysHash: hash.hash, seen: hash.seen, diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
      await holdIfAsked(db);
      await db.close();
      process.exit(0);
    }

    if (spec.phase === 'module_ops') {
      // 2026-10-02 (leo: 「跨节点读回要真验」): 走**群模块** —— 与 AI 的 group_read / group_say / group_autopilot
      //   背后**同一批函数** (createGroup/joinGroup/groupMessages/groupSend), 不是裸 store 原语。
      //   群模块的 dataDir 与 groups 文件都认本进程 HOME/BOLLOON_HOME (2026-10-02 才修) ⇒ 这里显式设成本节点 HOME。
      process.env.BOLLOON_HOME = spec.home;
      const gw = await import('../../src/agents/gateway-group.js');
      // ⚠ 2026-10-02: 与群模块**共用同一个** CID/helia 节点 (模块的 getDb() = getCIDDatabase())。
      //   同进程再起一个 adapter 会共用同一个 dataDir/keystore ⇒ 两个节点抢单写锁 ⇒ 出现「一绿一红」的假象。
      const { getCIDDatabase } = await import('../../src/orbitdb/cid-database.js');
      const cdb = getCIDDatabase();
      const mode = spec.mode ?? 'create';
      const fsum = (ms: Array<{ from: string; text: string }>): string =>
        crypto.createHash('sha256').update(ms.map((m) => `${m.from}|${m.text}`).join('\n')).digest('hex').slice(0, 16);

      if (mode === 'create') {
        const r = await gw.createGroup(spec.group || 'p0-module', spec.acl ? { acl: spec.acl } : undefined);
        const gid = (r as unknown as { group: { id: string } }).group.id;
        // 邀请链接走模块自己的口 (group 对象不一定带 link) —— 与 CLI `task group link` 同口径
        const link = await gw.groupLink(gid).catch(() => null);
        const tSend = Date.now();
        for (let i = 0; i < (spec.count ?? 0); i++) await gw.groupSend(gid, `m${i}`, spec.from || 'A');
        const msgs = await gw.groupMessages(gid, 1000);
        out({ ...base, ok: true, mode, groupId: gid, link,
              seen: msgs.length, keysHash: fsum(msgs), sendMs: Date.now() - tSend,
              peerId: cdb.peerId, addrs: cdb.listenAddrs(), diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
        await holdIfAsked(db);
        /* 与群模块共用同一节点 ⇒ 不在这里关 (进程退出即结束) */
        process.exit(0);
      }

      if (mode === 'join_read') {
        // 2026-10-02: 拨号**重试**且**一次都不许静默吞错** —— 上一版把拨号异常吞了,
        //   红的时候完全看不出是"没连上"还是"连上了没落块"(违反仓里「失败有没有被吞」那条规矩)。
        const dialErrors: string[] = [];
        const dials = spec.addrs ?? [];
        for (let attempt = 1; attempt <= 4; attempt++) {
          let ok = 0;
          for (const a of dials) {
            try { await cdb.dial(a); ok++; } catch (e) { dialErrors.push(`try${attempt} ${a.slice(-24)}: ${String((e as Error)?.message ?? e).slice(0, 80)}`); }
          }
          if (ok > 0) break;
          await new Promise((res) => setTimeout(res, 750 * attempt));
        }
        const j = await gw.joinGroup(spec.link!);
        const gid = (j as unknown as { group?: { id: string } }).group?.id ?? spec.groupId!;
        const want = spec.waitFor ?? 1;
        const tWait = Date.now();
        const deadline = Date.now() + (spec.timeoutMs ?? 60_000);
        let seen = 0;
        let lastError: string | null = null;
        let attempts = 0;
        while (Date.now() < deadline) {
          attempts++;
          try { seen = (await gw.groupMessages(gid, 1000)).length; lastError = null; }
          catch (e) { lastError = String((e as Error)?.message ?? e).slice(0, 160); }
          if (seen >= want) break;
          await new Promise((res) => setTimeout(res, spec.pollMs ?? 500));
        }
        const spoke = await gw.groupSend(gid, `回写-${spec.from || 'B'}`, spec.from || 'B');
        const after = await gw.groupMessages(gid, 1000);
        out({ ...base, ok: seen >= want, mode, groupId: gid, seen, want, waitMs: Date.now() - tWait, polls: attempts,
              dialAttempts: dials.length, dialErrors: dialErrors.slice(0, 6), lastError,
              spoke: spoke.ok, spokeError: spoke.error ?? null, afterSeen: after.length, keysHash: fsum(after),
              peerId: cdb.peerId, addrs: cdb.listenAddrs(), diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
        await holdIfAsked(db);
        /* 与群模块共用同一节点 ⇒ 不在这里关 (进程退出即结束) */
        process.exit(seen >= want ? 0 : 1);
      }

      // read_only: 本节点重启后按 groupId 读 (验「对方写进来的, 我这边能读到」)
      //   ⚠ 供块的节点必须活着, 且**读的一方要拨它** (门自己的规矩, S4 就是这么过的)
      for (const a of spec.addrs ?? []) { try { await cdb.dial(a); } catch { /* 拨不通就靠 pubsub 发现 */ } }
      const want2 = spec.waitFor ?? 1;
      const dl2 = Date.now() + (spec.timeoutMs ?? 60_000);
      let msgs = await gw.groupMessages(spec.groupId!, 1000);
      while (msgs.length < want2 && Date.now() < dl2) {
        await new Promise((res) => setTimeout(res, spec.pollMs ?? 500));
        try { msgs = await gw.groupMessages(spec.groupId!, 1000); } catch { /* 还没落块 */ }
      }
      out({ ...base, ok: true, mode, groupId: spec.groupId, seen: msgs.length, keysHash: fsum(msgs),
            peerId: cdb.peerId, addrs: cdb.listenAddrs(), diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
      /* 与群模块共用同一节点 ⇒ 不在这里关 (进程退出即结束) */
      process.exit(0);
    }

    if (spec.phase === 'send_only') {
      const store = await db.openStoreByAddress(spec.address!, 'events', { accessController: { write: ['*'] } });
      if (!store) { out({ ...base, ok: false, error: 'openStoreByAddress 返回 null' }); process.exit(1); }
      const before = (await store.all()).length;
      const n = spec.count ?? 0;
      let err: string | null = null;
      let written = 0;
      for (let i = 0; i < n; i++) {
        try { await store.add({ from: spec.from || 'B', text: `off${i}`, seq: i, ts: Date.now() }); written++; }
        catch (e: any) { err = String(e?.message || e).slice(0, 200); break; }
      }
      const hash = await keysHash(store);
      out({ ...base, ok: err === null, before, written, error: err, keysHash: hash.hash, seen: hash.seen,
            peerId: db.peerId, addrs: db.listenAddrs(), diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
      await holdIfAsked(db);
      await db.close();
      process.exit(err === null ? 0 : 1);
    }

    if (spec.phase === 'shard_append') {
      // 按分片写入 count 条: 每片最多 SHARD_SIZE 条, manifest 记各片地址
      const group = spec.group || 'p0-shard';
      const manifest = await db.openStore(manifestStoreName(group), 'keyvalue', { accessController: { write: ['*'] } });
      const n = spec.count ?? 0;
      const t0s = Date.now();
      const actors = Math.max(1, spec.distinctActors ?? 1);
      for (let i = 0; i < n; i++) {
        const a = i % actors;
        await appendEvent(db, manifest, group, {
          from: spec.from || 'A',
          text: `e${i}`,
          seq: i,
          ts: Date.now(),
          // N 个**不同身份** (P5 要"N 个 agent", 不是 N 条同源消息)
          actorId: `did:key:z6MkAgent${String(a).padStart(6, '0')}`,
          actor: `agent-${a}`,
        });
      }
      const shards = await listShards(manifest, group);
      out({ ...base, ok: true, group, appended: n, shards, manifestAddress: manifest.address,
            sendMs: Date.now() - t0s, peerId: db.peerId, addrs: db.listenAddrs(),
            diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
      await holdIfAsked(db);
      await db.close();
      process.exit(0);
    }

    if (spec.phase === 'shard_tail') {
      // 新节点: 按地址打开 manifest (1 个 key) → 只打开**最后一片** → 量耗时
      const group = spec.group || 'p0-shard';
      for (const a of spec.addrs ?? []) {
        try { await db.dial(a); } catch { /* 拨不通就如实继续 (会体现在耗时/失败里) */ }
      }
      const tM = Date.now();
      const manifest = await db.openStoreByAddress(spec.address!, 'keyvalue', { accessController: { write: ['*'] } });
      const manifestMs = Date.now() - tM;
      if (!manifest) { out({ ...base, ok: false, error: 'manifest 打不开' }); process.exit(1); }
      const w = await waitForManifest(manifest, group, { timeoutMs: 30000 });
      const shards = w.manifest.shards;
      const tail = await readTail(db, manifest, group, { waitMs: 90000 });
      const tailMs = tail.waitedMs;
      out({ ...base, ok: true, group, shardCount: shards.length, manifestWaitMs: w.waitedMs, manifestComplete: w.complete,
            shards: shards.map((s) => ({ i: s.index, count: s.count })),
            manifestMs, tailMs, tailEntries: tail.entries.length, tailComplete: tail.complete, openedShards: tail.openedShards,
            peerId: db.peerId, addrs: db.listenAddrs(), diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
      await holdIfAsked(db);
      await db.close();
      process.exit(0);
    }

    if (spec.phase === 'probe_sync') {
      // 诊断相位: dial → 按地址打开 → 每 5s 打一次「日志长度 / pubsub 订阅者 / 磁盘」, 看它卡在哪一环。
      const dialed: string[] = [];
      for (const a of spec.addrs ?? []) {
        try { await db.dial(a); dialed.push(a); } catch (e: any) { dialed.push(`✗ ${String(e?.message || e).slice(0, 80)}`); }
      }
      let store: OrbitDBStore | null = null;
      let openError: string | null = null;
      const tOpen = Date.now();
      try { store = await db.openStoreByAddress(spec.address!, 'events', { accessController: { write: ['*'] } }); }
      catch (e: any) { openError = `${e?.name}: ${String(e?.message || e).slice(0, 160)}`; }
      const ticks: Array<Record<string, unknown>> = [];
      const n = spec.count ?? 12;
      for (let i = 0; i < n; i++) {
        const seen = store ? (await store.all().catch(() => [])).length : -1;
        const subs = db.pubsubSubscribers(spec.address!);
        const tick = { t: i * 5, seen, subscribers: subs.length, diskKB: Math.round(diskBytes(dataDir) / 1024) };
        ticks.push(tick);
        out({ ...base, tick });
        if (seen >= (spec.waitFor ?? 1)) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      out({ ...base, ok: true, dialed, openError, openMs: Date.now() - tOpen, ticks, peerId: db.peerId });
      await db.close();
      process.exit(0);
    }

    // join_and_wait / open_and_wait
    const dialed: string[] = [];
    const dialErrors: string[] = [];
    if (spec.dial !== false && Array.isArray(spec.addrs)) {
      for (const a of spec.addrs) {
        try { await db.dial(a); dialed.push(a); }
        catch (e: any) { dialErrors.push(`${a} → ${String(e?.message || e).slice(0, 120)}`); }
      }
    }
    let store: OrbitDBStore | null = null;
    let openError: string | null = null;
    const tOpen = Date.now();
    try { store = await db.openStoreByAddress(spec.address!, 'events', { accessController: { write: ['*'] } }); }
    catch (e: any) { openError = `${e?.name || 'Error'}: ${String(e?.message || e).slice(0, 220)}`; }
    const openMs = Date.now() - tOpen;

    if (!store) {
      out({ ...base, ok: false, openError, dialed, dialErrors, peerId: db.peerId, addrs: db.listenAddrs(),
            seen: 0, diskBytes: diskBytes(dataDir), openMs, totalMs: Date.now() - t0 });
      await db.close();
      process.exit(0); // 打不开是**如实结果**, 由父进程判 (不当崩溃)
    }

    const want = spec.waitFor ?? 1;
    const w = await waitForCount(store, want, spec.timeoutMs ?? 60000, spec.pollMs ?? 500);
    const hash = await keysHash(store);
    out({ ...base, ok: !w.timedOut, openError: null, dialed, dialErrors, openMs, ...w,
          keysHash: hash.hash, seen: hash.seen, peerId: db.peerId, addrs: db.listenAddrs(),
          // 诊断: 没拨号的节点若仍看到消息, 这两项能说明它是怎么连上的
          peerConnections: db.peerConnections(), subscribers: db.pubsubSubscribers(spec.address!).length,
          diskBytes: diskBytes(dataDir), totalMs: Date.now() - t0 });
    await holdIfAsked(db);
    await db.close();
    process.exit(0);
  } catch (e: any) {
    out({ ...base, ok: false, fatal: String(e?.message || e).slice(0, 300) });
    try { await db.close(); } catch { /* 忽略 */ }
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  try { await dbForSignal?.close(); } catch { /* 忽略 */ }
  process.exit(0);
});
let dbForSignal: OrbitDBAdapter | null = null;

void main();
