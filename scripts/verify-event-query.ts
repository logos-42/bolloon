/**
 * verify-event-query.ts — P4 门: 查询面 (2026-10-01)
 *
 * 三条判据 (对应 plan §P4):
 *   ① 同一份索引 + 同一个查询 ⇒ **逐条相同**的结果; 且"真 store 读回"与"纯函数推导"一致
 *   ② 窄范围查询**不许扫全量** (keysScanned 远小于 keysRead); 反事实: 宽范围必须扫满 (证明计数不是假的)
 *   ③ **没有索引时不许假装成功** ⇒ 显式 degraded 标注, 且结果项里**只有元数据 + CID** (无正文)
 *
 * 另加: 过滤器真生效 (topic/capability/type/actor/group) · limit 截断要置 complete=false
 *
 * 跑法: npx tsx scripts/verify-event-query.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildEvent, canonicalJson } from '../src/orbitdb/event-shell.js';
import {
  ALLOWED_INDEX_ENTRY_KEYS,
  openIndexStores,
  rebuildIndexes,
  readBundleFromStores,
  writeBundle,
  indexBundleCanonicalJson,
  type IndexStoreName,
} from '../src/orbitdb/event-index.js';
import { queryIndexBundle, queryWithoutIndex, emptyBundle, planQuery, type QuerySpec } from '../src/orbitdb/event-query.js';

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string): void => { checks.push({ name, pass, detail }); };

const T0 = 1_700_000_000_000;
const N = 300;
const TOPICS = ['physics', 'commerce', 'research'];
const CAPS = ['plasma-sim', 'logistics', 'materials'];
const ACTORS = ['a1', 'a2', 'a3'];

async function main(): Promise<void> {
  console.log('P4 · 事件查询面 (真索引 store + 纯函数对照)');
  console.log('');

  // ── 造事件流: 300 条, ts 从 T0 起每分钟一条 (topic/capability/actor 轮转)
  const events = [] as Awaited<ReturnType<typeof buildEvent>>[];
  for (let i = 0; i < N; i++) {
    events.push(await buildEvent({
      type: i % 5 === 0 ? 'delegation' : 'message',
      actor: ACTORS[i % ACTORS.length]!,
      actorId: `did:key:z6Mk${ACTORS[i % ACTORS.length]!}`,
      group: 'g-main',
      ts: T0 + i * 60_000,
      summary: `ev${i}`,
      topic: TOPICS[i % TOPICS.length]!,
      capability: CAPS[i % CAPS.length]!,
    }));
  }
  console.log(`   事件流: ${events.length} 条 (ts ${new Date(T0).toISOString()} 起每分钟一条)`);

  // ── 索引: 纯函数 + 真 store 各一份
  const pureBundle = rebuildIndexes(events);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-p4-'));
  const { getCIDDatabase } = await import('../src/orbitdb/cid-database.js');
  const db = getCIDDatabase();
  const stores = await openIndexStores(db as never);
  const written = await writeBundle(stores, pureBundle);
  const storeBundle = await readBundleFromStores(stores);
  console.log(`   索引: 纯函数 ${Object.values(pureBundle).flat().length} 项 · 真 store 写入 ${written} 项 · 读回 ${Object.values(storeBundle).flat().length} 项`);
  console.log('');

  // ─────────────────── ① 同索引同查询 ⇒ 逐条相同
  const q1: QuerySpec = { topic: 'physics', group: 'g-main' };
  const a = queryIndexBundle(pureBundle, q1);
  const b = queryIndexBundle(pureBundle, q1);
  const c = queryIndexBundle(storeBundle, q1);
  // 2026-10-01 自己踩的: 原来用 JSON.stringify 比 —— 它对**字段顺序**敏感, store 往返后键序变了就判不等,
  // 看着像"真 store 与纯函数不一致", 其实两边内容和条数完全一样。改用 canonicalJson (键排序)
  // + 另加一条与序列化无关的集合比较 (sorted ids)。两条一起才说明问题。
  const ja = canonicalJson(a.items), jb = canonicalJson(b.items), jc = canonicalJson(c.items);
  const idsA = a.items.map((i) => i.id).sort().join(',');
  const idsC = c.items.map((i) => i.id).sort().join(',');
  console.log('   ① 同索引同查询 ⇒ 逐条相同');
  console.log(`      纯函数两次: ${a.items.length} 条 / ${b.items.length} 条 · 真 store 读回: ${c.items.length} 条`);
  check('① 同一份索引、同一个查询, 两次结果逐字相同 (纯函数)', ja === jb && a.items.length > 0, `${a.items.length} 条, 逐字相同=${ja === jb}`);
  check('① 真 store 读回的索引与纯函数推导一致 (canonical 逐字)', ja === jc, `纯=${a.items.length} 条 vs store=${c.items.length} 条, canonical 相同=${ja === jc}`);
  check('① 同一查询的**结果集合**相同 (与序列化无关: sorted ids)', idsA === idsC && idsA.length > 0, `集合相同=${idsA === idsC} · 共 ${a.items.length} 条`);
  check('① 计划器选对索引 (有时间窗→by-time, 有 topic→by-topic)', planQuery({ since: 1 }) === 'by-time' && planQuery({ topic: 'x' }) === 'by-topic',
        `since→${planQuery({ since: 1 })} · topic→${planQuery({ topic: 'x' })}`);
  console.log('');

  // ─────────────────── ② 窄范围不扫全量 (+ 宽范围反事实)
  const narrow: QuerySpec = { since: T0 + 10 * 60_000, until: T0 + 19 * 60_000 };   // 10 分钟的窗
  const narrowRes = queryIndexBundle(pureBundle, narrow);
  const wideRes = queryIndexBundle(pureBundle, { since: T0, until: T0 + N * 60_000 });
  console.log('   ② 范围裁剪 (by-time 的 ts 是 13 位补零 ⇒ 字符串序=时间序 ⇒ 可二分+早停)');
  console.log(`      窄窗(10 分钟): 命中 ${narrowRes.items.length} 条 · keysRead=${narrowRes.keysRead} keysScanned=${narrowRes.keysScanned}`);
  console.log(`      宽窗(全量):     命中 ${wideRes.items.length} 条 · keysRead=${wideRes.keysRead} keysScanned=${wideRes.keysScanned}`);
  check('② 窄范围查询远小于全量扫描 (裁剪真的发生)', narrowRes.keysScanned < narrowRes.keysRead / 3 && narrowRes.keysScanned > 0,
        `窄窗 keysScanned=${narrowRes.keysScanned} < keysRead/3=${Math.floor(narrowRes.keysRead / 3)}`);
  check('② 反事实: 宽范围必须扫满 (证明这个计数不是写死的)', wideRes.keysScanned === wideRes.keysRead && wideRes.keysRead === N,
        `宽窗 keysScanned=${wideRes.keysScanned} == keysRead=${wideRes.keysRead} == N=${N}`);
  check('② 窄窗命中都在窗口内 (没有漏也没有多)', narrowRes.items.every((i) => i.ts >= narrow!.since! && i.ts <= narrow!.until!),
        `${narrowRes.items.length} 条全部落在 [since, until]`);
  console.log('');

  // ─────────────────── ③ 无索引 ⇒ 显式降级 (不假装成功) + 只出元数据
  const noIndex = queryWithoutIndex({ topic: 'physics' });
  const plainEmpty = queryIndexBundle(emptyBundle(), { topic: 'physics' });
  console.log('   ③ 无索引 / 只出元数据');
  console.log(`      无索引: items=${noIndex.items.length} degraded=${noIndex.degraded?.reason}`);
  check('③ 没有索引时**不是**静默空结果, 而是带 degraded 标注', noIndex.items.length === 0 && noIndex.degraded?.reason === 'no-index' && !!noIndex.degraded.hint,
        `items=${noIndex.items.length} degraded=${noIndex.degraded?.reason}`);
  check('③ 有索引但确实查不到 ⇒ 不带 degraded (两者可区分)', plainEmpty.items.length === 0 && plainEmpty.degraded === undefined,
        `items=${plainEmpty.items.length} degraded=${String(plainEmpty.degraded)}`);
  const allowed = new Set<string>(ALLOWED_INDEX_ENTRY_KEYS as readonly string[]);
  const badKeys = wideRes.items.flatMap((it) => Object.keys(it).filter((k) => !allowed.has(k)));
  const hasContentish = wideRes.items.some((it) => 'content' in (it as Record<string, unknown>) || 'body' in (it as Record<string, unknown>));
  check('③ 结果项只有元数据 + CID (无正文/无 content 字段)', badKeys.length === 0 && !hasContentish,
        `白名单外键 ${badKeys.length} 个 · 含 content/body=${hasContentish}`);
  console.log('');

  // ─────────────────── 过滤器 + limit
  const byType = queryIndexBundle(pureBundle, { type: 'delegation' });
  const byActor = queryIndexBundle(pureBundle, { actor: 'a2' });
  const byCap = queryIndexBundle(pureBundle, { capability: 'logistics' });
  const limited = queryIndexBundle(pureBundle, { since: T0, until: T0 + N * 60_000, limit: 10 });
  const expectDeleg = events.filter((e) => e.type === 'delegation').length;
  const expectActor = events.filter((e) => e.actor === 'a2').length;
  const expectCap = events.filter((e) => e.capability === 'logistics').length;
  console.log('   过滤器与截断');
  console.log(`      type=delegation ${byType.items.length} (期望 ${expectDeleg}) · actor=a2 ${byActor.items.length} (期望 ${expectActor}) · capability=logistics ${byCap.items.length} (期望 ${expectCap})`);
  console.log(`      limit=10 ⇒ 出 ${limited.items.length} 条 · complete=${limited.complete}`);
  check('过滤器真生效 (type / actor / capability)', byType.items.length === expectDeleg && byActor.items.length === expectActor && byCap.items.length === expectCap,
        `${byType.items.length}/${expectDeleg} · ${byActor.items.length}/${expectActor} · ${byCap.items.length}/${expectCap}`);
  check('limit 截断时 complete=false 且出满 limit 条', limited.items.length === 10 && limited.complete === false, `${limited.items.length} 条 complete=${limited.complete}`);
  check('limit 未触发时 complete=true', wideRes.complete === true, `complete=${wideRes.complete}`);
  console.log('');

  await db.close().catch(() => { /* 忽略 */ });
  const bad = checks.filter((x) => !x.pass);
  console.log('   判据:');
  for (const x of checks) console.log(`      ${x.pass ? '✓' : '✗'} ${x.name} — ${x.detail}`);
  console.log('');
  console.log(`   结论: ${checks.length - bad.length}/${checks.length} 通过` + (bad.length ? ' —— 有真失败' : ''));
  console.log(`   留档: ${dir}`);
  if (!bad.length) { try { fs.rmSync(dir, { recursive: true, force: true }); console.log('   (全绿, 临时目录已清理)'); } catch { /* 忽略 */ } }
  process.exit(bad.length ? 1 : 0);
}

void main();
