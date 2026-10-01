/**
 * verify-event-index.ts — P2 门: 统一事件外壳 + **可重建的索引层** (2026-10-01)
 *
 * 判据 (五条, 每条都在真 OrbitDB 上跑, 不是内存假 store):
 *   ① 同一语义事件跨库字段一致
 *      —— 同一批 payload 分别写进**两个独立节点**的 events store (两个 dataDir / 两份独立本地日志),
 *         读回后逐事件比 canonical 字节。附反事实: 只往 B 多写 3 条 → A 必须不受影响 (证明是两个库, 不是自比)。
 *         实测并如实记录: OrbitDB store 地址 = manifest 参数的哈希(含 store 名), **与身份无关** ——
 *         所以"两个库"的证据是 dataDir + 本地日志独立, 不是地址不同 (这一点原先猜错了, 已按实测改写)。
 *   ② **删索引 → 由事件流重建 → 逐字节相同** (本任务的核心判据)
 *      —— 索引节点写满三个 kv store → 落盘快照 → **删掉三个索引 store 的目录** → 重开
 *         (地址不变 = 同一个 slot) 且断言 `all()` 为空 (= 索引真没了) → **只读事件流**重放 →
 *         比 dag-cbor 字节 + sha256 指纹。附反事实: 少喂一条事件, 指纹必须变。
 *   ③ 老记录 (缺新字段) 可读
 *      —— 真事件流里混进 2 条 cid-database.ts 形状的老 CIDRecord (只有 {id,agentId,timestamp,type,content,
 *         metadata,version}), 从真 store 读回后仍能用, 且缺的字段逐条报出来。
 *   ④ 反事实: 索引项里**不许出现正文**
 *      —— 语料每条正文 8KB 带唯一标记; 逐事件在索引项**字段值的字符串叶子**里搜正文。
 *         三个面分开报: 白名单外键 / 整段正文命中 / 超摘要预算的正文命中。
 *         附 ①反向自检: 手工塞正文必须变红; ②正文放大 50× 索引项字节数必须不变 (索引大小与正文无关)。
 *   ⑤ 重建不依赖任何中心索引
 *      —— 另起一个**全新节点** (新 dataDir, 重放前三个索引断言为空) 只吃事件流重放, 指纹相同;
 *         且重建函数的输入只有事件数组 (`rebuildIndexes(events)` —— 签名即证据)。
 *
 * 跑法: npx tsx scripts/verify-event-index.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256 } from 'multiformats/hashes/sha2';
import { OrbitDBAdapter } from '../src/orbitdb/cid-database.js';
import {
  EVENT_TYPES,
  buildEvent,
  canonicalJson,
  checkMonotonicTs,
  contentCid,
  inspectEventStream,
  readEvent,
  type EventShell,
} from '../src/orbitdb/event-shell.js';
import {
  ALLOWED_INDEX_ENTRY_KEYS,
  INDEX_STORE_NAMES,
  bytesEqual,
  indexBundleCbor,
  indexBundleFingerprint,
  indexBundleCanonicalJson,
  indexLeakReport,
  openIndexStores,
  readBundleFromStores,
  rebuildIndexes,
  toHex,
  writeBundle,
  type IndexBundle,
  type IndexEntry,
  type IndexStore,
  type IndexStoreName,
} from '../src/orbitdb/event-index.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-p2-'));
const T0 = 1_700_000_000_000;
const N_EVENTS = 120;
const BODY_REPEAT = 200; // ≈8KB 正文/事件 (大内容: 只出 CID, 不进外壳)

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail });
};
const kb = (n: number): string => `${(n / 1024).toFixed(1)}KB`;

/** 确定性伪随机 (不用 Math.random: 门要可复现) */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TOPICS = ['market', 'planning', 'memory', 'ops', 'defi'];
const CAPS = ['summarize', 'translate', 'trade', 'index', 'verify'];

interface Corpus {
  /** 按 ts 升序的写库 payload (外壳对象 + 2 条老记录) */
  payloads: unknown[];
  events: EventShell[];
  bodies: Map<string, string>;
  legacyIds: string[];
}

/** 造语料: N_EVENTS 条新外壳 + 2 条老 CIDRecord, ts 严格递增 */
async function buildCorpus(eventsDir: string): Promise<Corpus> {
  const rnd = lcg(20261001);
  const payloads: unknown[] = [];
  const events: EventShell[] = [];
  const bodies = new Map<string, string>();
  const legacyIds: string[] = [];
  const legacyAt = new Set([17, 71]); // 这两条位置上写老记录

  for (let i = 0; i < N_EVENTS; i++) {
    const ts = T0 + i * 1000;
    const body = `BODY-${i}-` + 'lorem ipsum dolor sit amet consectetur '.repeat(BODY_REPEAT) + `-${Math.floor(rnd() * 1e9)}`;
    if (legacyAt.has(i)) {
      // 老记录: 完全按 cid-database.ts save() 的形状 —— 没有 v/actorId/group/summary/topic
      const content = { body };
      const id = await contentCid({ agentId: 'legacy-agent', type: 'memory', content });
      const legacy: Record<string, unknown> = {
        id,
        agentId: 'legacy-agent',
        timestamp: ts,
        type: i === 17 ? 'memory' : 'state',
        content,
        metadata: { topic: 'legacy-topic', source: 'p1-old-writer' },
        version: 1,
        dbAddress: '/orbitdb/zdpuLegacySimulatedAddressForShape',
      };
      payloads.push(legacy);
      legacyIds.push(id);
      const ev = readEvent(legacy);
      events.push(ev);
      bodies.set(ev.id, body);
      continue;
    }
    const ev = await buildEvent({
      type: EVENT_TYPES[i % EVENT_TYPES.length]!,
      actor: `agent-${i % 7}`,
      actorId: `did:bolloon:agent-${i % 7}`,
      group: 'p2-net',
      ts,
      summary: `事件 ${i}: ${EVENT_TYPES[i % EVENT_TYPES.length]} 在 ${TOPICS[i % 5]}`,
      content: { body },
      ...(i % 6 === 0 ? {} : { topic: TOPICS[i % 5]! }),
      ...(i % 4 === 0 ? { capability: CAPS[i % 5]! } : {}),
      ...(i % 11 === 0 && i > 0 ? { refs: [{ type: 'event' as const, id: events[i - 1]!.id, rel: 'caused-by' }] } : {}),
      metadata: { seq: i, corpus: path.basename(eventsDir) },
    });
    payloads.push(ev);
    events.push(ev);
    bodies.set(ev.id, body);
  }
  return { payloads, events, bodies, legacyIds };
}

/** 目录/文件占用 (真字节) */
function dirBytes(p: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk(p);
  return total;
}

/** store 内容快照 (每个 store: 项数 + canonical 字节的 sha256) */
async function snapshot(stores: Record<IndexStoreName, IndexStore>): Promise<Record<string, { n: number; sha: string }>> {
  const out: Record<string, { n: number; sha: string }> = {};
  for (const name of INDEX_STORE_NAMES) {
    const all = await stores[name].all();
    const lines = all.map((e) => `${String(e.key)}\t${canonicalJson(e.value)}`).sort();
    const digest = await sha256.digest(new TextEncoder().encode(lines.join('\n')));
    out[name] = { n: all.length, sha: toHex(digest.digest) };
  }
  return out;
}

async function main(): Promise<void> {
  console.log('P2 · 统一事件外壳 + 可重建索引层 (真 OrbitDB)');
  console.log(`   根目录: ${ROOT}`);
  console.log(`   语料: ${N_EVENTS} 条 (10 种 type 全覆盖) + 2 条老 CIDRecord, 正文 ≈${BODY_REPEAT * 41}B/条`);
  console.log('');

  const eventsDir = path.join(ROOT, 'node-events');
  const mirrorDir = path.join(ROOT, 'node-mirror');
  const indexDir = path.join(ROOT, 'node-index');
  const freshDir = path.join(ROOT, 'node-fresh');

  const corpus = await buildCorpus(eventsDir);

  // ── 阶段 1: 事件流写进真 events store (节点 A)
  const t1 = Date.now();
  const evNode = new OrbitDBAdapter(eventsDir);
  const evStream = await evNode.openStore('bolloon-events', 'events', { accessController: { write: ['*'] } });
  for (const p of corpus.payloads) await evStream.add(p);
  const rawA = (await evStream.all()).map((e) => e.value);
  const readA = inspectEventStream(rawA);
  console.log('① 事件流 (节点 A, events store)');
  console.log(`   store 地址: ${evStream.address}   写入 ${corpus.payloads.length} 条 · 读回 ${rawA.length} 条 · ${Date.now() - t1}ms`);
  console.log(`   读回: 事件 ${readA.events.length} 条 (其中老记录 ${readA.legacyCount} 条) · 校验 issues ${readA.issues.length} 条`);
  check('① 事件条数原样读回', rawA.length === corpus.payloads.length && readA.events.length === corpus.payloads.length, `写=${corpus.payloads.length} 读回 raw=${rawA.length} 外壳=${readA.events.length}`);
  check('③ 老记录从真 store 读回后可读 (legacyCount=2)', readA.legacyCount === 2, `legacyCount=${readA.legacyCount}`);
  const hardA = readA.issues.filter((i) => i.code !== 'LEGACY_COERCED' && i.code !== 'TS_NOT_MONOTONIC');
  check('① 读回的外壳全部通过严格校验', hardA.length === 0, `硬 issue=${hardA.length}${hardA[0] ? ' · 首条: ' + hardA[0].code + ' ' + hardA[0].message : ''}`);
  const legacyCoercions = readA.issues.filter((i) => i.code === 'LEGACY_COERCED').map((i) => i.message);
  console.log(`   老记录补齐动作 (逐条报, 共 ${legacyCoercions.length}):`);
  for (const m of Array.from(new Set(legacyCoercions)).slice(0, 6)) console.log(`     · ${m}`);

  // 单调性: 真 store 的 all() 顺序如实报; 另给正/负控制证明检查器不是摆设
  const storeOrderMono = checkMonotonicTs(readA.events);
  const sortedMono = checkMonotonicTs([...readA.events].sort((a, b) => a.ts - b.ts));
  const badStream = [readA.events[0]!, readA.events[5]!, { ...readA.events[2]!, ts: readA.events[2]!.ts - 7000 }];
  const badMono = checkMonotonicTs(badStream);
  console.log(`   时间单调: store 返回顺序 ${storeOrderMono.length} 处倒退 · 排序后 ${sortedMono.length} 处 · 故意乱序样本 ${badMono.length} 处`);
  if (badMono[0]) console.log(`     · 负控制原文: ${badMono[0].message.slice(0, 120)}`);
  check('② 单调检查器真会红 (故意乱序必报)', badMono.length === 1 && badMono[0]!.code === 'TS_NOT_MONOTONIC', `故意乱序 → ${badMono.length} 处`);
  check('② 按 ts 排序的事件流是单调的 (正控制)', sortedMono.length === 0, `${sortedMono.length} 处倒退`);

  // 老记录的"缺字段"-证据: 直接从真 store 的 raw payload 上看
  const rawLegacy = rawA.find((r) => {
    const o = r as Record<string, unknown>;
    return typeof o.id === 'string' && corpus.legacyIds.includes(o.id);
  }) as Record<string, unknown> | undefined;
  const legacyMissing = rawLegacy ? ['v', 'actorId', 'group', 'summary', 'topic'].filter((k) => !(k in rawLegacy)) : [];
  check('③ 老记录在真 store 里确实缺新字段 (不是造出来的假老记录)', !!rawLegacy && legacyMissing.length === 5, `缺: ${legacyMissing.join(',')}`);
  if (rawLegacy) {
    const back = readEvent(rawLegacy);
    console.log(`   老记录 (真 store 读回) → type=${String(rawLegacy.type)} 映射为 ${back.type} · ts=${back.ts} · cid=${back.cid?.slice(0, 20)}… · actorId=${back.actorId}`);
  }

  await evNode.close();

  // ── 阶段 2: 同一批 payload 写进**另一个节点** (跨库/跨节点一致性)
  const evNodeM = new OrbitDBAdapter(mirrorDir);
  const evStreamM = await evNodeM.openStore('bolloon-events-mirror', 'events', { accessController: { write: ['*'] } });
  for (const p of corpus.payloads) await evStreamM.add(p);
  const rawB = (await evStreamM.all()).map((e) => e.value);
  const readB = inspectEventStream(rawB);
  const byIdA = new Map(readA.events.map((e) => [e.id, e]));
  let mismatch = 0;
  const mismatchIds: string[] = [];
  for (const e of readB.events) {
    const a = byIdA.get(e.id);
    if (!a || canonicalJson(a) !== canonicalJson(e)) {
      mismatch++;
      mismatchIds.push(e.id.slice(0, 16));
    }
  }
  console.log('');
  console.log('① 跨库一致 (节点 B: 另一个 dataDir / 另一份独立日志 / 另一个 store 名)');
  console.log(`   A 地址: ${evStream.address}`);
  console.log(`   B 地址: ${evStreamM.address}`);
  console.log(`   两个库地址不同: ${evStream.address !== evStreamM.address} · 不同 dataDir: ${eventsDir !== mirrorDir}`);
  check('① 同一语义事件跨两个独立的库逐字段一致', rawB.length === corpus.payloads.length && mismatch === 0, `不一致 ${mismatch}/${readB.events.length}${mismatchIds.length ? ' · ' + mismatchIds.slice(0, 3).join(',') : ''}`);
  check('① A/B 是两个不同的库 (地址不同)', evStream.address !== evStreamM.address, `A=${evStream.address} B=${evStreamM.address}`);
  // 反事实: 证明"跨库一致"不是同一个库自比 —— 只往 B 多写 3 条, B 变 123, A 必须仍是 120
  for (let k = 0; k < 3; k++) {
    await evStreamM.add(await buildEvent({ type: 'message', actor: 'mirror-only', actorId: 'did:bolloon:mirror-only', group: 'p2-net', ts: T0 + 900_000 + k, summary: `只在 B 上的第 ${k} 条` }));
  }
  const rawB2 = (await evStreamM.all()).map((e) => e.value);
  const evNodeA2 = new OrbitDBAdapter(eventsDir);
  const evStreamA2 = await evNodeA2.openStore('bolloon-events', 'events', { accessController: { write: ['*'] } });
  const rawA2 = (await evStreamA2.all()).map((e) => e.value);
  console.log(`   独立性反证: B 追加 3 条后 B=${rawB2.length} 条, A 仍=${rawA2.length} 条`);
  check('① A/B 真独立 (B 多写 3 条不影响 A)', rawB2.length === corpus.payloads.length + 3 && rawA2.length === corpus.payloads.length, `A=${rawA2.length} B=${rawB2.length}`);
  await evNodeM.close();
  await evNodeA2.close();

  // ── 阶段 3: 索引节点 —— 写满三个 kv store
  const expected = rebuildIndexes(readA.events);
  const expectedFp = await indexBundleFingerprint(expected);
  const indexNode = new OrbitDBAdapter(indexDir);
  const stores1 = await openIndexStores(indexNode);
  const t3 = Date.now();
  const written = await writeBundle(stores1, expected);
  const read1 = await readBundleFromStores(stores1);
  const fp1 = await indexBundleFingerprint(read1);
  const snap1 = await snapshot(stores1);
  const addr1 = Object.fromEntries(INDEX_STORE_NAMES.map((n) => [n, stores1[n].address ?? '(无地址)']));
  console.log('');
  console.log('② 索引节点: 写满三个 keyvalue store');
  console.log(`   写入 ${written} 项 · ${Date.now() - t3}ms · 索引项共 ${fp1.entries} 项 (topic ${fp1.perStore['by-topic']}/${fp1.perStore['by-capability']} cap/${fp1.perStore['by-time']} time)`);
  for (const n of INDEX_STORE_NAMES) console.log(`   · ${n.padEnd(14)} addr=${addr1[n]}  项=${snap1[n]!.n} 内容sha=${snap1[n]!.sha.slice(0, 16)}…`);
  console.log(`   读回内容指纹: sha256=${fp1.sha256.slice(0, 24)}… · ${fp1.bytes}B (dag-cbor)`);
  check('② 读回 == 纯函数推导 (canonical JSON)', indexBundleCanonicalJson(read1) === indexBundleCanonicalJson(expected), `${indexBundleCanonicalJson(read1).length}B vs ${indexBundleCanonicalJson(expected).length}B`);
  check('② 读回 == 纯函数推导 (dag-cbor 字节)', bytesEqual(indexBundleCbor(read1), indexBundleCbor(expected)), `指纹 ${fp1.sha256.slice(0, 16)} == ${expectedFp.sha256.slice(0, 16)}`);

  // ④ 反事实: 索引里没有正文
  const leak1 = indexLeakReport(readA.events, read1, { bodyOf: (ev) => corpus.bodies.get(ev.id) ?? null });
  console.log('');
  console.log('④ 反事实 · 索引项里只有元数据 + CID');
  console.log(`   逐事件搜正文: 检查了 ${leak1.checkedEvents} 个事件, 无法比对 ${leak1.uncheckedEvents.length} 个`);
  console.log(`   · 白名单外键: ${leak1.forbiddenKeys.length ? leak1.forbiddenKeys.join(',') : '无'} (允许: ${ALLOWED_INDEX_ENTRY_KEYS.join(',')})`);
  console.log(`   · 整段正文命中: ${leak1.fullBodyHits} · 超摘要预算正文命中: ${leak1.overBudgetHits}`);
  console.log(`   · 索引项最多 ${leak1.maxEntryKeys} 个键 · 索引文本 ${kb(leak1.totalIndexBytes)} vs 正文总计 ${kb(leak1.totalBodyChars)}`);
  check('④ 索引项键全在白名单里', leak1.forbiddenKeys.length === 0, `白名单外键: ${leak1.forbiddenKeys.join(',') || '无'}`);
  check('④ 索引里没有整段正文', leak1.fullBodyHits === 0, `命中 ${leak1.fullBodyHits} 个事件 (正文 ≥64 字才判)`);
  check('④ 索引里没有超预算正文片段', leak1.overBudgetHits === 0, `命中 ${leak1.overBudgetHits} 个事件 (正文 >160 字的尾部)`);
  check('④ 索引总体积远小于正文 (大内容只出 CID)', leak1.totalIndexBytes * 8 < leak1.totalBodyChars, `索引 ${kb(leak1.totalIndexBytes)} vs 正文 ${kb(leak1.totalBodyChars)} (索引 = 正文的 ${((leak1.totalIndexBytes / leak1.totalBodyChars) * 100).toFixed(1)}%)`);
  check('④ 索引里没有"空"事件 (每个事件都真被索引了)', leak1.orphanEntryIds.length === 0 && leak1.details.every((d) => d.entryKeys.length > 0), `孤立索引项 ${leak1.orphanEntryIds.length} 个`);

  // ④ 索引项大小与正文大小无关 (O(1) in body size): 同一条事件, 正文 1KB vs 50KB
  const bodySmall = 'x'.repeat(1024);
  const bodyBig = 'y'.repeat(50 * 1024);
  const pair = [
    await buildEvent({ type: 'observation', actor: 'a', actorId: 'did:a', group: 'g', ts: T0 + 1, summary: '同摘要', topic: 'same-topic', capability: 'same-cap', content: { body: bodySmall } }),
    await buildEvent({ type: 'observation', actor: 'a', actorId: 'did:a', group: 'g', ts: T0 + 2, summary: '同摘要', topic: 'same-topic', capability: 'same-cap', content: { body: bodyBig } }),
  ];
  const pairBodies = new Map<string, string>([[pair[0]!.id, bodySmall], [pair[1]!.id, bodyBig]]);
  const pairDetails = indexLeakReport(pair, rebuildIndexes(pair), { bodyOf: (ev) => pairBodies.get(ev.id) ?? null }).details.slice().sort((a, b) => a.bodyChars - b.bodyChars);
  const sizeStable = pairDetails[0]!.entryBytes === pairDetails[1]!.entryBytes;
  console.log(`   正文放大 50× (${pairDetails[0]!.bodyChars}B → ${pairDetails[1]!.bodyChars}B) 时索引项字节: ${pairDetails[0]!.entryBytes}B → ${pairDetails[1]!.entryBytes}B`);
  check('④ 正文放大 50× 索引项字节数不变 (索引与正文大小无关)', sizeStable && pairDetails[1]!.bodyChars > 40 * pairDetails[0]!.bodyChars, `索引 ${pairDetails[0]!.entryBytes}B vs ${pairDetails[1]!.entryBytes}B · 正文 ${pairDetails[0]!.bodyChars}B vs ${pairDetails[1]!.bodyChars}B`);

  // ④ 反向自检: 手工塞正文进索引项, 检查器必须变红 (否则上面的 0 是写空的)
  const victimId = readA.events[3]!.id;
  const victimBody = corpus.bodies.get(victimId)!;
  const poisoned: IndexBundle = { 'by-topic': [], 'by-capability': [], 'by-time': [] };
  let poisonedCount = 0;
  for (const name of INDEX_STORE_NAMES) {
    for (const e of read1[name]) {
      const entry = { ...(e.value as unknown as Record<string, unknown>) };
      if (entry.id === victimId) {
        entry.content = { body: victimBody }; // 白名单外的键 + 整段正文
        poisonedCount++;
      }
      poisoned[name].push({ store: name, key: e.key, value: entry as unknown as IndexEntry });
    }
  }
  const leak2 = indexLeakReport(readA.events, poisoned, { bodyOf: (ev) => corpus.bodies.get(ev.id) ?? null });
  console.log(`   反向自检: 往 ${poisonedCount} 个索引项塞进正文 → 白名单外键=${JSON.stringify(leak2.forbiddenKeys)} 整段正文命中=${leak2.fullBodyHits} 超预算命中=${leak2.overBudgetHits}`);
  check('④ 反向自检: 塞正文后检查器必红 (证明上面不是写空的)', leak2.forbiddenKeys.includes('content') && leak2.fullBodyHits > 0 && leak2.overBudgetHits > 0, `forbidden=${leak2.forbiddenKeys.join(',')} full=${leak2.fullBodyHits} over=${leak2.overBudgetHits}`);

  await indexNode.close();

  // ── 阶段 4: **删掉索引** → 只读事件流重放 → 逐字节相同
  const beforeBytes = dirBytes(path.join(indexDir, 'stores'));
  const storeDirs = INDEX_STORE_NAMES.map((n) => {
    const addr = addr1[n]!;
    const dirName = addr.startsWith('/orbitdb/') ? addr.slice('/orbitdb/'.length) : addr;
    return { name: n, addr, p: path.join(indexDir, 'stores', 'orbitdb', dirName) };
  });
  console.log('');
  console.log('② 删索引 (真删目录):');
  let deleted = 0;
  for (const s of storeDirs) {
    const exists = fs.existsSync(s.p);
    const bytes = exists ? dirBytes(s.p) : 0;
    if (exists) fs.rmSync(s.p, { recursive: true, force: true });
    if (exists) deleted++;
    console.log(`   · ${s.name.padEnd(14)} ${path.relative(ROOT, s.p)} 存在=${exists} (${kb(bytes)}) → 已删`);
  }
  console.log(`   stores 目录: ${kb(beforeBytes)} → ${kb(dirBytes(path.join(indexDir, 'stores')))}`);
  check('② 三个索引 store 目录都被真删掉', deleted === 3, `删了 ${deleted}/3`);

  // 重开同一个 dataDir (= 同一身份 ⇒ 同一地址/slot), 断言索引空了
  const indexNode2 = new OrbitDBAdapter(indexDir);
  const stores2 = await openIndexStores(indexNode2);
  const addr2 = Object.fromEntries(INDEX_STORE_NAMES.map((n) => [n, stores2[n].address ?? '(无地址)']));
  const emptyAfter = await snapshot(stores2);
  const sameSlots = INDEX_STORE_NAMES.filter((n) => addr1[n] === addr2[n]).length;
  console.log(`   重开: 地址与之前相同(slot 未变) ${sameSlots}/3 · 删后各 store 项数 = ${INDEX_STORE_NAMES.map((n) => emptyAfter[n]!.n).join('/')}`);
  check('② 删后 store 真的是空的 (不是"看着没了")', INDEX_STORE_NAMES.every((n) => emptyAfter[n]!.n === 0), INDEX_STORE_NAMES.map((n) => `${n}=${emptyAfter[n]!.n}`).join(' '));
  check('② 重开后是同一个 store slot (不是偷偷换了新库)', sameSlots === 3, `${sameSlots}/3 地址一致`);

  // 只读事件流重放: 重新开事件节点读原始 payload (索引侧此刻是空的)
  const evNode2 = new OrbitDBAdapter(eventsDir);
  const evStream2 = await evNode2.openStore('bolloon-events', 'events', { accessController: { write: ['*'] } });
  const rawReplay = (await evStream2.all()).map((e) => e.value);
  const replayRead = inspectEventStream(rawReplay);
  const t4 = Date.now();
  const replayed = rebuildIndexes(replayRead.events); // ← 输入**只有**事件数组
  await writeBundle(stores2, replayed);
  const read2 = await readBundleFromStores(stores2);
  const fp2 = await indexBundleFingerprint(read2);
  const rebuiltBytes = indexBundleCbor(read2);
  const firstBytes = indexBundleCbor(read1);
  console.log(`   重放输入: 事件流 ${replayRead.events.length} 条 (老记录 ${replayRead.legacyCount}) → 派生 ${fp2.entries} 项 · ${Date.now() - t4}ms`);
  console.log(`   重建内容指纹: sha256=${fp2.sha256.slice(0, 24)}… · ${fp2.bytes}B (dag-cbor)`);
  check('② 重建指纹 == 删除前指纹 (sha256)', fp1.sha256 === fp2.sha256, `${fp1.sha256.slice(0, 20)} vs ${fp2.sha256.slice(0, 20)}`);
  check('② 重建字节 == 删除前字节 (逐字节)', bytesEqual(firstBytes, rebuiltBytes), `cbOR ${firstBytes.length}B vs ${rebuiltBytes.length}B`);
  check('② canonical JSON 也逐字相同', indexBundleCanonicalJson(read1) === indexBundleCanonicalJson(read2), `${indexBundleCanonicalJson(read2).length} 字`);
  check('② 重建只吃事件流 (输入条数 == 写库条数)', replayRead.events.length === corpus.payloads.length, `${replayRead.events.length}/${corpus.payloads.length}`);

  // 反事实: 少喂一条 → 指纹必须变 (证明上面的"相同"不是空比较)
  const shortFp = await indexBundleFingerprint(rebuildIndexes(replayRead.events.slice(0, -1)));
  const tamperFp = await indexBundleFingerprint(rebuildIndexes(replayRead.events.map((e, i) => (i === 0 ? { ...e, summary: e.summary + '!' } : e))));
  console.log(`   反事实: 少喂 1 条 → ${shortFp.sha256.slice(0, 16)}… (差) · 改 1 条 summary → ${tamperFp.sha256.slice(0, 16)}… (差)`);
  check('② 反事实: 少一条事件指纹就变 (比较是有效的)', shortFp.sha256 !== fp1.sha256 && tamperFp.sha256 !== fp1.sha256, `short=${shortFp.sha256.slice(0, 12)} tamper=${tamperFp.sha256.slice(0, 12)} base=${fp1.sha256.slice(0, 12)}`);
  await indexNode2.close();
  await evNode2.close();

  // ── 阶段 5: 全新节点 (新 dataDir) 重放 → 相同
  const freshNode = new OrbitDBAdapter(freshDir);
  const freshExistedBefore = fs.existsSync(freshDir);
  const freshStores = await openIndexStores(freshNode);
  const emptyFresh = await snapshot(freshStores); // 重放**之前**必须全空
  const evNode3 = new OrbitDBAdapter(eventsDir);
  const evStream3 = await evNode3.openStore('bolloon-events', 'events', { accessController: { write: ['*'] } });
  const rawFresh = (await evStream3.all()).map((e) => e.value);
  const freshRead = inspectEventStream(rawFresh);
  const freshBundle = rebuildIndexes(freshRead.events);
  await writeBundle(freshStores, freshBundle);
  const freshBack = await readBundleFromStores(freshStores);
  const fpFresh = await indexBundleFingerprint(freshBack);
  const freshAddrs = Object.fromEntries(INDEX_STORE_NAMES.map((n) => [n, freshStores[n].address ?? '(无地址)']));
  console.log('');
  console.log('⑤ 全新节点重放 (新 dataDir; 建这个目录前它存在吗 = ' + freshExistedBefore + ')');
  console.log(`   重放前三个索引项数 = ${INDEX_STORE_NAMES.map((n) => emptyFresh[n]!.n).join('/')} (必须全 0: 内容 100% 来自事件流)`);
  console.log(`   地址与 index 节点相同 = ${INDEX_STORE_NAMES.every((n) => freshAddrs[n] === addr1[n])} —— 符合预期: OrbitDB 地址 = manifest 参数的哈希(含 store 名), 与身份/dataDir 无关; 独立性靠 dataDir 与本地日志`);
  console.log(`   fresh 数据目录 ${path.relative(ROOT, freshDir)}: 建这个节点前目录存在=${freshExistedBefore} · 写索引后 stores=${kb(dirBytes(path.join(freshDir, 'stores')))} (写索引前 3 个 store 都是 0 项)`);
  console.log(`   fresh 指纹: sha256=${fpFresh.sha256.slice(0, 24)}… · ${fpFresh.bytes}B`);
  const oldIds = new Set(read1['by-time'].map((e) => e.value.id));
  const freshIds = new Set(freshBack['by-time'].map((e) => e.value.id));
  check('⑤ 全新节点 (索引重放前全空) 重放结果逐字节相同', fpFresh.sha256 === fp1.sha256 && bytesEqual(indexBundleCbor(freshBack), firstBytes), `${fpFresh.sha256.slice(0, 20)} vs ${fp1.sha256.slice(0, 20)}`);
  check('⑤ fresh 节点重放前索引真的是空的', INDEX_STORE_NAMES.every((n) => emptyFresh[n]!.n === 0), INDEX_STORE_NAMES.map((n) => `${n}=${emptyFresh[n]!.n}`).join(' '));
  check('⑤ 集合完全相同 (不是碰巧字节相同)', oldIds.size === freshIds.size && [...oldIds].every((id) => freshIds.has(id)), `${freshIds.size} 个事件 id`);
  await freshNode.close();
  await evNode3.close();

  // ── 数字表
  console.log('');
  console.log('   数字表 (真 OrbitDB, 单机):');
  console.log(`      事件 ${corpus.payloads.length} 条 · 正文总计 ${kb(leak1.totalBodyChars)} · 索引 ${fp1.entries} 项 / ${kb(fp1.bytes)} (dag-cbor)`);
  console.log(`      索引项/事件 = ${(fp1.entries / corpus.payloads.length).toFixed(2)} (1 时间线 + 有 topic/capability 才加)`);
  console.log(`      单节点索引占用: ${kb(dirBytes(path.join(indexDir, 'stores')))} (+ blocks ${kb(dirBytes(path.join(indexDir, 'ipfs')))})`);
  console.log(`      事件流节点占用: ${kb(dirBytes(path.join(eventsDir, 'stores')))} (+ blocks ${kb(dirBytes(path.join(eventsDir, 'ipfs')))})`);

  const bad = checks.filter((c) => !c.pass);
  console.log('');
  console.log('   判据:');
  for (const c of checks) console.log(`      ${c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`);
  console.log('');
  console.log(`   结论: ${checks.length - bad.length}/${checks.length} 通过` + (bad.length ? ' —— 有真失败, 见上' : ''));
  console.log(`   留档目录: ${ROOT}`);
  if (!bad.length) {
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log('   (全绿, 临时目录已清理)');
  }
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL:', (e as Error)?.message ?? e);
  console.error(String((e as Error)?.stack ?? '').split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
