/**
 * event-index.test.ts — 统一事件外壳 + 可重建索引 (P2) 的纯函数测试 (2026-10-01)
 *
 * 纪律: **不起真 OrbitDB 节点** (真节点验收在 `scripts/verify-event-index.ts`)。
 * 这里只测两条线:
 *   ① event-shell: 严格校验 / canonical / 时间单调 / 老记录向后兼容
 *   ② event-index: 索引 = f(事件流) 的纯函数性 / 逐字节可重建 / 索引里没有正文
 *
 * 反事实自检 (重要): ④ 那组用例除了"干净数据不报警", 还**故意塞进正文**证明检查器真会红 ——
 * 否则一个永远返回 0 的检查器也能让门"全绿"。
 */

import { describe, it, expect } from 'vitest';
import {
  ALLOWED_INDEX_ENTRY_KEYS,
  INDEX_STORE_NAMES,
  applyEvent,
  bytesEqual,
  capabilityKey,
  deriveIndexEntries,
  indexBundleCanonicalJson,
  indexBundleCbor,
  indexBundleFingerprint,
  indexEntryFor,
  indexLeakReport,
  parseIndexKey,
  pruneIndexes,
  readBundleFromStores,
  rebuildIndexes,
  timeKey,
  topicKey,
  writeBundle,
  type IndexEntry,
  type IndexStore,
  type IndexStoreName,
} from '../orbitdb/event-index.js';
import {
  EVENT_SHELL_VERSION,
  EVENT_TYPES,
  MAX_SUMMARY_LEN,
  buildEvent,
  canonicalJson,
  canonicalize,
  checkMonotonicTs,
  assertMonotonicTs,
  deriveSummary,
  eventCid,
  inspectEvent,
  inspectEventStream,
  isCid,
  readEvent,
  validateEvent,
  type EventShell,
} from '../orbitdb/event-shell.js';

// ─────────────────────────── 夹具 ───────────────────────────

/** 内存假 keyvalue store (结构上满足 IndexStore; 与真 OrbitDBStore 同形) */
class FakeKv implements IndexStore {
  readonly address: string;
  private kv = new Map<string, unknown>();
  constructor(name: string) {
    this.address = `fake://${name}`;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.kv.set(key, JSON.parse(JSON.stringify(value)) as unknown); // 学 OrbitDB: 过一遍 dag-cbor 会丢 undefined
  }
  async all(): Promise<Array<{ key: string; value: unknown }>> {
    return Array.from(this.kv.entries()).map(([key, value]) => ({ key, value }));
  }
  async get(key: string): Promise<unknown> {
    return this.kv.get(key);
  }
  async del(key: string): Promise<void> {
    this.kv.delete(key);
  }
}

/** 不带 del 的 store (用来验"裁剪时如实报 skipped") */
class FakeKvNoDel implements IndexStore {
  readonly address = 'fake://no-del';
  private kv = new Map<string, unknown>();
  async put(key: string, value: unknown): Promise<void> {
    this.kv.set(key, JSON.parse(JSON.stringify(value)) as unknown);
  }
  async all(): Promise<Array<{ key: string; value: unknown }>> {
    return Array.from(this.kv.entries()).map(([key, value]) => ({ key, value }));
  }
}

const freshStores = (): Record<IndexStoreName, IndexStore> => ({
  'by-topic': new FakeKv('by-topic'),
  'by-capability': new FakeKv('by-capability'),
  'by-time': new FakeKv('by-time'),
});

const BODY = (i: number): string => `BODY-${i}-` + 'lorem ipsum dolor sit amet '.repeat(40);

interface Corpus {
  events: EventShell[];
  bodies: Map<string, string>;
}

/** 确定性语料 (无 Math.random): 10 种 type 全覆盖, 部分缺 topic/capability, 含 1 条老记录 */
async function buildCorpus(): Promise<Corpus> {
  const events: EventShell[] = [];
  const bodies = new Map<string, string>();
  const T0 = 1_700_000_000_000;
  const topics = ['market', 'planning', 'memory', 'ops', 'defi'];
  for (let i = 0; i < 30; i++) {
    const content = { body: BODY(i) };
    const ev = await buildEvent({
      type: EVENT_TYPES[i % EVENT_TYPES.length]!,
      actor: `agent-${i % 5}`,
      actorId: `did:bolloon:agent-${i % 5}`,
      group: 'p2-corpus',
      ts: T0 + i * 1000,
      summary: `摘要 ${i}`, // 显式短摘要 (与正文无重叠) ⇒ 索引里不该有正文
      content,
      ...(i % 7 === 0 ? {} : { topic: topics[i % topics.length]! }),
      ...(i % 3 === 0 ? { capability: `cap-${i % 4}` } : {}),
      ...(i === 4 ? { refs: [{ type: 'event' as const, id: 'parent-cid-placeholder', rel: 'parent' }] } : {}),
    });
    events.push(ev);
    bodies.set(ev.id, content.body);
  }
  // 老记录 (缺 v/actorId/group/summary/topic; type 是老类型 memory)
  const legacy = {
    id: 'bafyreilegacyrecord000000000000000000000000000000000000000',
    agentId: 'agent-old',
    timestamp: T0 + 30_000,
    type: 'memory',
    content: { body: BODY(999) },
    metadata: { topic: 'legacy-topic' },
    version: 1,
  };
  const coerced = readEvent(legacy);
  events.push(coerced);
  bodies.set(coerced.id, BODY(999));
  return { events, bodies };
}

// ─────────────────────── ① event-shell 严格校验 ───────────────────────

describe('event-shell · 严格校验 (不默许)', () => {
  it('10 种 type 都在闭集里, 且都有 v1', () => {
    expect(EVENT_TYPES).toHaveLength(10);
    expect(EVENT_TYPES).toContain('message');
    expect(EVENT_TYPES).toContain('discovery');
    expect(EVENT_SHELL_VERSION).toBe(1);
  });

  it('未知 type → UNKNOWN_TYPE (报错, 不是归到 observation)', () => {
    const bad = { v: 1, id: 'x', type: 'chitchat', actor: 'a', actorId: 'did:a', group: 'g', ts: 1, summary: 's' };
    const r = inspectEvent(bad);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('UNKNOWN_TYPE');
    expect(() => validateEvent(bad)).toThrowError(/UNKNOWN_TYPE|未知事件类型/);
  });

  it('缺必填逐个报 (v/id/type/actor/actorId/group/ts/summary)', () => {
    const r = inspectEvent({});
    expect(r.ok).toBe(false);
    const fields = new Set(r.issues.map((i) => i.field));
    for (const f of ['v', 'id', 'type', 'actor', 'actorId', 'group', 'ts', 'summary']) expect(fields.has(f)).toBe(true);
    expect(r.issues.every((i) => i.code === 'MISSING_FIELD')).toBe(true);
  });

  it('summary 超上限 → SUMMARY_TOO_LONG (有界摘要是外壳不变式)', async () => {
    const bad = { v: 1, id: 'x', type: 'message', actor: 'a', actorId: 'did:a', group: 'g', ts: 1, summary: 'x'.repeat(MAX_SUMMARY_LEN + 1) };
    expect(inspectEvent(bad).issues.map((i) => i.code)).toContain('SUMMARY_TOO_LONG');
    await expect(
      buildEvent({ type: 'message', actor: 'a', actorId: 'did:a', group: 'g', ts: 1, summary: 'x'.repeat(MAX_SUMMARY_LEN + 1) }),
    ).rejects.toThrow();
  });

  it('非法 cid → INVALID_CID; 合法 cid 放行', async () => {
    const base = { v: 1, id: 'x', type: 'message', actor: 'a', actorId: 'did:a', group: 'g', ts: 1, summary: 's' };
    expect(isCid('bafyreifakeshouldfail')).toBe(false);
    expect(inspectEvent({ ...base, cid: 'bafyreifakeshouldfail' }).issues.map((i) => i.code)).toContain('INVALID_CID');
    const real = await buildEvent({ type: 'message', actor: 'a', actorId: 'did:a', group: 'g', ts: 1, summary: 's', content: { a: 1 } });
    expect(isCid(real.cid)).toBe(true);
    expect(inspectEvent({ ...base, cid: real.cid }).ok).toBe(true);
  });

  it('topic/capability 超长与空串都报; refs 的 type 必须在闭集里', () => {
    const base = { v: 1, id: 'x', type: 'message', actor: 'a', actorId: 'did:a', group: 'g', ts: 1, summary: 's' };
    expect(inspectEvent({ ...base, topic: '' }).issues.map((i) => i.code)).toContain('BAD_FIELD_TYPE');
    expect(inspectEvent({ ...base, capability: 'c'.repeat(121) }).issues.map((i) => i.code)).toContain('LABEL_TOO_LONG');
    expect(inspectEvent({ ...base, refs: [{ type: 'telepathy', id: 'z' }] }).issues.map((i) => i.code)).toContain('BAD_REF');
    expect(inspectEvent({ ...base, refs: [{ type: 'event', id: '' }] }).issues.map((i) => i.code)).toContain('BAD_REF');
  });

  it('未来版本 → UNSUPPORTED_VERSION (不静默降级)', () => {
    const base = { id: 'x', type: 'message', actor: 'a', actorId: 'did:a', group: 'g', ts: 1, summary: 's' };
    expect(inspectEvent({ ...base, v: 2 }).issues.map((i) => i.code)).toContain('UNSUPPORTED_VERSION');
  });
});

// ─────────────────── ② canonical 序列化 + 内容寻址 ───────────────────

describe('event-shell · canonical 序列化', () => {
  it('键序不影响序列化字节', () => {
    const a = { z: 1, a: { q: [3, 2, 1], b: 'x' }, m: null };
    const b = { m: null, a: { b: 'x', q: [3, 2, 1] }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"b":"x","q":[3,2,1]},"m":null,"z":1}');
  });

  it('undefined 字段被丢弃 (dag-cbor 编不了), 但数组里的 undefined 抛异常', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalize([1, undefined])).toThrow(/undefined/);
  });

  it('非有限数字抛异常 —— 拒绝 JSON.stringify 的静默变 null', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/非有限数字/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/非有限数字/);
    expect(JSON.stringify({ a: Number.NaN })).toBe('{"a":null}'); // 对照: 原生行为会静默毁数据
  });

  it('同语义事件同 id; 改任何字段 id 都变; 键序无关', async () => {
    const mk = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      v: 1, type: 'task', actor: 'a1', actorId: 'did:a1', group: 'g', ts: 100, refs: [], summary: 's', ...extra,
    });
    const id1 = await eventCid(mk());
    expect(await eventCid(mk())).toBe(id1);
    expect(await eventCid(mk({ ts: 101 }))).not.toBe(id1);
    // 键序无关 (canonicalize 在 eventCid 里)
    const shuffled: Record<string, unknown> = {};
    for (const k of Object.keys(mk()).reverse()) shuffled[k] = mk()[k];
    expect(await eventCid(shuffled)).toBe(id1);
    // eventCid 剔除 id 自身 ⇒ 带不带 id 都一样
    expect(await eventCid({ ...mk(), id: 'whatever' })).toBe(id1);
  });

  it('deriveSummary 有界且确定性', () => {
    expect(deriveSummary({ body: 'x'.repeat(999) }, 40).length).toBe(40);
    expect(deriveSummary({ summary: '  a\n b ' })).toBe('a b');
    expect(deriveSummary({ b: 1, a: 2 })).toBe(deriveSummary({ a: 2, b: 1 }));
  });
});

// ─────────────────── 时间单调 (如实报, 不默许) ───────────────────

describe('event-shell · 时间非单调', () => {
  const ev = (ts: number, id: string): { ts: number; id: string } => ({ ts, id });
  /** 合法外壳 (流级检查要先过单条校验, 否则报的是 UNRECOGNIZED_RECORD) */
  const shell = (ts: number): EventShell =>
    validateEvent({ v: 1, id: `e-${ts}`, type: 'message', actor: 'a', actorId: 'did:a', group: 'g', ts, summary: 's' });

  it('递增流 0 issue; 倒退流逐条报 TS_NOT_MONOTONIC', () => {
    expect(checkMonotonicTs([ev(1, 'a'), ev(2, 'b'), ev(2, 'c')])).toHaveLength(0);
    const issues = checkMonotonicTs([ev(1, 'a'), ev(5, 'b'), ev(3, 'c'), ev(2, 'd')]);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.field)).toEqual(['[2].ts', '[3].ts']);
    expect(issues.every((i) => i.code === 'TS_NOT_MONOTONIC')).toBe(true);
    expect(issues[0]!.message).toContain('时间倒退');
  });

  it('assertMonotonicTs 抛 TS_NOT_MONOTONIC (硬失败路径)', () => {
    try {
      assertMonotonicTs([ev(2, 'a'), ev(1, 'b')]);
      throw new Error('不该走到这里');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('TS_NOT_MONOTONIC');
    }
  });

  it('默认 report: 如实进 issues 但不算失败; enforce 才 ok=false', () => {
    const raw = [shell(2), shell(1)];
    const report = inspectEventStream(raw);
    expect(report.events).toHaveLength(2);
    expect(report.issues.map((i) => i.code)).toContain('TS_NOT_MONOTONIC');
    expect(report.ok).toBe(true);
    const enforce = inspectEventStream(raw, { monotonic: 'enforce' });
    expect(enforce.ok).toBe(false);
    expect(inspectEventStream(raw, { monotonic: 'off' }).issues).toHaveLength(0);
  });
});

// ─────────────────── ③ 老记录向后兼容 ───────────────────

describe('event-shell · 老记录 (缺新字段) 可读', () => {
  it('CIDRecord 形状 → 外壳; 缺的字段逐条报 warning, 不假装本来就有', () => {
    const legacy = { id: 'bafyold000', agentId: 'old-agent', timestamp: 12345, type: 'knowledge', content: { text: '旧知识' }, metadata: { topic: 't1' }, version: 3, parentId: 'bafyparent' };
    const event = readEvent(legacy);
    expect(event.v).toBe(1);
    expect(event.type).toBe('discovery'); // knowledge → discovery 的显式映射
    expect(event.actor).toBe('old-agent');
    expect(event.actorId).toBe('old-agent'); // 没有伪造 DID, 原样顶替
    expect(event.ts).toBe(12345);
    expect(event.cid).toBe('bafyold000'); // 老记录本身就是内容寻址的 ⇒ 当正文 CID
    expect(event.topic).toBe('t1');
    expect(event.summary).toBe('旧知识'); // 由 content 现推
    expect(event.refs).toEqual([{ type: 'event', id: 'bafyparent', rel: 'parent' }]);
    expect(event.metadata?.legacy).toMatchObject({ type: 'knowledge', version: 3, agentId: 'old-agent' });
  });

  it('老类型映射表覆盖全部 5 个老类型', () => {
    const map: Record<string, string> = { memory: 'observation', context: 'observation', state: 'result', ui: 'observation', knowledge: 'discovery' };
    for (const [old, now] of Object.entries(map)) {
      expect(readEvent({ id: 'x' + old, agentId: 'a', timestamp: 1, type: old, content: 'c', metadata: {}, version: 1 }).type).toBe(now);
    }
  });

  it('老记录缺 timestamp/actorId/metadata 也能读 (补 0 / 空串), 且在流里被算成 legacyCount', () => {
    const event = readEvent({ id: 'bafyminimal', type: 'state', content: 'c' });
    expect(event.ts).toBe(0);
    expect(event.actorId).toBe('');
    expect(event.type).toBe('result');
    const stream = inspectEventStream([{ id: 'bafyminimal', type: 'state', content: 'c' }]);
    expect(stream.legacyCount).toBe(1);
    expect(stream.issues.every((i) => i.code === 'LEGACY_COERCED')).toBe(true);
    expect(stream.ok).toBe(true); // 兼容性告知不算失败
  });

  it('既不是外壳也不是老记录 → UNRECOGNIZED_RECORD (不硬塞空壳)', () => {
    expect(() => readEvent({ hello: 'world' })).toThrowError(/UNRECOGNIZED_RECORD/);
    expect(() => readEvent(42)).toThrowError(/UNRECOGNIZED_RECORD/);
    const r = inspectEventStream([{ hello: 'world' }]);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.code).toBe('UNRECOGNIZED_RECORD');
  });
});

// ─────────────────── ④ 索引 = f(事件流) ───────────────────

describe('event-index · 索引是事件流的纯函数', () => {
  it('deriveIndexEntries: 时间线必进, topic/capability 有才进', async () => {
    const withBoth = await buildEvent({ type: 'task', actor: 'a', actorId: 'did:a', group: 'g', ts: 7, summary: 's', topic: 'T', capability: 'C', content: { b: 1 } });
    const stores = deriveIndexEntries(withBoth).map((d) => d.store);
    expect(new Set(stores)).toEqual(new Set(INDEX_STORE_NAMES));
    const bare = await buildEvent({ type: 'task', actor: 'a', actorId: 'did:a', group: 'g', ts: 7, summary: 's' });
    expect(deriveIndexEntries(bare).map((d) => d.store)).toEqual(['by-time']);
  });

  it('key 形状: 补零的时间在前, 可按前缀查 topic/capability, 反解可回', async () => {
    const ev = await buildEvent({ type: 'task', actor: 'a', actorId: 'did:a', group: 'g', ts: 1_700_000_000_123, summary: 's', topic: 'market', capability: 'cap' });
    expect(timeKey(ev)).toBe('1700000000123::' + encodeURIComponent(ev.id));
    expect(topicKey(ev)!.startsWith('market::1700000000123::')).toBe(true);
    expect(capabilityKey(ev)!.startsWith('cap::1700000000123::')).toBe(true);
    expect(topicKey({ ts: 1, id: 'x' })).toBeNull();
    const parsed = parseIndexKey('by-topic', topicKey(ev)!);
    expect(parsed).toEqual({ label: 'market', ts: 1_700_000_000_123, id: ev.id });
    expect(parseIndexKey('by-time', 'garbage')).toBeNull();
  });

  it('rebuildIndexes 与输入顺序无关, 且指向同一批事件 (同一次 derivation)', async () => {
    const { events } = await buildCorpus();
    const a = rebuildIndexes(events);
    const b = rebuildIndexes([...events].reverse());
    expect(indexBundleCanonicalJson(a)).toBe(indexBundleCanonicalJson(b));
    expect((await indexBundleFingerprint(a)).sha256).toBe((await indexBundleFingerprint(b)).sha256);
    // indexEntryFor 是白名单构造: refs/summary 是拷贝, 改动索引项不影响外壳
    const entry = indexEntryFor(events[0]!);
    expect(Object.keys(entry).sort()).toEqual(Object.keys(entry).filter((k) => (ALLOWED_INDEX_ENTRY_KEYS as readonly string[]).includes(k)).sort());
  });
});

// ─────────────────── 核心判据: 删索引 → 重放 → 逐字节相同 ───────────────────

describe('event-index · 删掉索引后由事件流重建 (逐字节相同)', () => {
  it('写进 store 读回来 = 重建结果; 换一批空 store 重放, 逐字节相同', async () => {
    const { events } = await buildCorpus();
    const derived = rebuildIndexes(events);

    const stores1 = freshStores();
    const written1 = await writeBundle(stores1, derived);
    const read1 = await readBundleFromStores(stores1);

    // 删索引: 换一批**完全空**的 store (等价于删掉索引目录), 只重放事件流
    const stores2 = freshStores();
    const replay = rebuildIndexes(events); // 只依赖事件数组
    await writeBundle(stores2, replay);
    const read2 = await readBundleFromStores(stores2);

    expect(written1).toBe(replay['by-time'].length + (derived['by-topic'].length) + (derived['by-capability'].length));
    // ① 读回 == 纯函数推导
    expect(indexBundleCanonicalJson(read1)).toBe(indexBundleCanonicalJson(derived));
    // ② 重建逐字节相同 (canonical JSON + dag-cbor 字节 + sha256 三道)
    expect(indexBundleCanonicalJson(read1)).toBe(indexBundleCanonicalJson(read2));
    expect(bytesEqual(indexBundleCbor(read1), indexBundleCbor(read2))).toBe(true);
    const f1 = await indexBundleFingerprint(read1);
    const f2 = await indexBundleFingerprint(read2);
    expect(f1.sha256).toBe(f2.sha256);
    expect(f1.bytes).toBe(f2.bytes);
    expect(f1.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 删干净了: 反事实 —— 把第二个 store 的某一个 key 去掉, 指纹必须变 (否则比较是空的)
    const tampered = JSON.parse(JSON.stringify(read2)) as typeof read2;
    tampered['by-time'] = tampered['by-time'].slice(1);
    expect((await indexBundleFingerprint(tampered)).sha256).not.toBe(f2.sha256);
  });

  it('增量写 (applyEvent 逐条) 与一次性重建逐字节相同', async () => {
    const { events } = await buildCorpus();
    const stores = freshStores();
    for (const ev of events) await applyEvent(stores, ev);
    const incremental = await readBundleFromStores(stores);
    const rebuilt = rebuildIndexes(events);
    expect(bytesEqual(indexBundleCbor(incremental), indexBundleCbor(rebuilt))).toBe(true);
    expect((await indexBundleFingerprint(incremental)).sha256).toBe((await indexBundleFingerprint(rebuilt)).sha256);
  });

  it('老记录也能进索引 (topic 来自 metadata, 归到 observation)', async () => {
    const event = readEvent({ id: 'bafyold000', agentId: 'old', timestamp: 5, type: 'memory', content: 'x', metadata: { topic: 'legacy-topic' }, version: 1 });
    const stores = deriveIndexEntries(event).map((d) => d.store);
    expect(stores).toContain('by-topic');
    const bundle = rebuildIndexes([event]);
    expect(bundle['by-topic'][0]!.key.startsWith('legacy-topic::')).toBe(true);
    expect(bundle['by-topic'][0]!.value.type).toBe('observation');
  });

  it('裁剪: 有 del 的真删; 没 del 的如实报 skipped (不假装删了)', async () => {
    const { events } = await buildCorpus();
    const bundle = rebuildIndexes(events);
    const stores = freshStores();
    await writeBundle(stores, bundle);
    // 塞一条陈旧项
    await stores['by-time'].put('0000000000000::stale', bundle['by-time'][0]!.value);
    const pruned = await pruneIndexes(stores, bundle);
    expect(pruned.removed).toBe(1);
    expect(pruned.skipped).toEqual([]);
    expect((await readBundleFromStores(stores))['by-time'].length).toBe(bundle['by-time'].length);

    const stubborn = { 'by-topic': new FakeKvNoDel(), 'by-capability': new FakeKvNoDel(), 'by-time': new FakeKvNoDel() } as Record<IndexStoreName, IndexStore>;
    await writeBundle(stubborn, bundle);
    await stubborn['by-time'].put('0000000000000::stale', bundle['by-time'][0]!.value);
    const pruned2 = await pruneIndexes(stubborn, bundle);
    expect(pruned2.removed).toBe(0);
    expect(pruned2.skipped[0]).toContain('未暴露 del');
  });
});

// ─────────────────── 反事实: 索引项里不许出现正文 ───────────────────

describe('event-index · 索引项只有元数据 + CID, 没有正文', () => {
  it('干净语料: 白名单外键 0、整段正文命中 0、超预算正文命中 0', async () => {
    const { events, bodies } = await buildCorpus();
    const bundle = rebuildIndexes(events);
    const report = indexLeakReport(events, bundle, { bodyOf: (ev) => bodies.get(ev.id) ?? null });
    expect(report.forbiddenKeys).toEqual([]);
    expect(report.fullBodyHits).toBe(0);
    expect(report.overBudgetHits).toBe(0);
    expect(report.checkedEvents).toBe(events.length);
    expect(report.orphanEntryIds).toEqual([]);
    // 索引项就是订阅集: 12 个键以内, 单项字节远小于正文
    expect(report.maxEntryKeys).toBeLessThanOrEqual(ALLOWED_INDEX_ENTRY_KEYS.length);
    expect(report.totalIndexBytes).toBeLessThan(report.totalBodyChars);
  });

  it('索引项的键逐个都在白名单里; 拿不到 bodyOf 的事件被如实算成 unchecked', async () => {
    const { events } = await buildCorpus();
    const bundle = rebuildIndexes(events);
    const report = indexLeakReport(events, bundle, { bodyOf: () => null });
    expect(report.uncheckedEvents).toHaveLength(events.length);
    expect(report.checkedEvents).toBe(0);
    for (const d of report.details) expect(d.entryKeys.every((k) => (ALLOWED_INDEX_ENTRY_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it('反事实自检: 手工往索引项里塞正文 → 检查器必须变红 (证明它没被写空)', async () => {
    const { events, bodies } = await buildCorpus();
    const bundle = rebuildIndexes(events);
    const victim = events[0]!;
    const body = bodies.get(victim.id)!;

    // (a) 塞整段正文进 summary
    const leak1 = rebuildIndexes(events);
    for (const name of INDEX_STORE_NAMES) {
      for (const e of leak1[name]) if (e.value.id === victim.id) (e.value as IndexEntry).summary = body;
    }
    expect(indexLeakReport(events, leak1, { bodyOf: (ev) => bodies.get(ev.id) ?? null }).fullBodyHits).toBe(1);

    // (b) 塞一个白名单外的 content 键 (带正文)
    const leak2 = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    for (const name of INDEX_STORE_NAMES) {
      for (const e of leak2[name]) if (e.value.id === victim.id) (e.value as unknown as Record<string, unknown>).content = { body };
    }
    const r2 = indexLeakReport(events, leak2, { bodyOf: (ev) => bodies.get(ev.id) ?? null });
    expect(r2.forbiddenKeys).toEqual(['content']);
    expect(r2.overBudgetHits).toBe(1); // 正文超出摘要预算的那一段也进了索引
  });
});
