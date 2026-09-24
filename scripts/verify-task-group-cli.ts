/**
 * verify-task-group-cli.ts — 2026-09-24
 *
 * 真跑验收 (每一步都是**真 CLI 子进程**: `node --import tsx src/cli-entry.ts`, 不是调函数):
 *
 *   (A) `bolloon task group create|join|list|link|leave` —— 以前 createGroup/joinGroup/listGroups
 *       只存在于 `src/agents/gateway-group.ts`, CLI 里没有任何入口 (外部接单者拿到群链接也进不来)。
 *   (B) `bolloon identity init|show` —— 以前建身份只有 readline 交互向导, 无 TTY 环境下
 *       `readline was closed` (ERR_USE_AFTER_CLOSE) → 新机器/第二实例建不出身份。
 *
 * **本脚本最关键的一条 (必须如实, 不许改断言让它变绿)**:
 *   「第二个身份能不能往别人建的群里真发消息?」
 *   实测答案 (三项, 逐项断言):
 *     ① **ACL 不拦**: 新群的 manifest `acl.write = ["*"]` → 另一个身份 (连 OrbitDB 写者身份都不同)
 *        `task post --kind deliver` **exit 0**, 消息被接受。
 *     ② **建群者读得回** (同机): B 与 A 共享同一份 OrbitDB store 目录时, A 用同一链接在新进程
 *        `task trail` **看得到** B 发的那条 (发送者标记是 B 自己的假名) → 同机跨进程端到端成立。
 *     ③ **但这不是"两台独立节点"**: C 用自己的 log/keystore (只共享 blocks) 时, 写入被接受,
 *        可 A **读不到** C 那条 —— 各自只看见自己的 log。缺的是**复制层** (bitswap / block broker),
 *        不是权限。所以**跨机仍不行** (真外机接单者发的消息传不回来)。
 *
 * 同机限定 (写清楚, 不许含糊): 让两个 HOME **共享块存储/store 目录**才能让第二个进程
 * 开得了同一个群 store (`~/.bolloon/orbitdb`, 见 cfa49eb 的 FsBlockstore 落盘)。
 * 这**只证明同机跨进程**, **不等于跨机可行** —— 跨机还缺 bitswap/block broker。
 *
 * 用法: npx tsx scripts/verify-task-group-cli.ts
 * 退出码: 0 = 全部通过; 1 = 有失败项。
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = path.join(os.tmpdir(), 'bolloon-tgcli-' + Date.now());
const CLI = ['--import', 'tsx', 'src/cli-entry.ts'];

let passed = 0, failed = 0, skipped = 0;
const fails: string[] = [];
const notes: string[] = [];

function check(name: string, ok: boolean, detail?: string): boolean {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
  return ok;
}
function skip(name: string, why: string) { skipped++; console.log(`  ⤵️  ${name} (skip: ${why})`); }
function head(t: string) { console.log(`\n${'═'.repeat(78)}\n${t}\n${'═'.repeat(78)}`); }

interface Run { code: number; out: string; err: string }
/** 真跑一条 CLI (独立进程); stdin 关掉 = 模拟无 TTY (以前 `bolloon setup` 就死在这) */
function cli(home: string, args: string[]): Run {
  const r = spawnSync(process.execPath, [...CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
  return { code: r.status ?? -1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
/** 从 stdout 里把信封 JSON 抠出来 (human 段可能在前或后) */
function json(r: Run): any {
  const i = r.out.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(r.out.slice(i)); } catch { return null; }
}
const h = (home: string, ...p: string[]) => path.join(home, ...p);
const idFile = (home: string) => h(home, '.bolloon', 'identity.json');
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ── 隐私闸: 群管理输出里不许出现的形态 ──────────────────────────────────────
// 注意 `orbitdb` 不在列表里: create/link 就是要打印邀请链接 (群自己的公开标识, 不是节点地址)。
const FORBIDDEN: Array<[string, RegExp]> = [
  ['原始 DID', /did:[a-z0-9]+:/i],
  ['钱包地址', /0x[0-9a-fA-F]{40}/],
  ['peerId(12D3Koo)', /12D3Koo[A-Za-z0-9]{8,}/],
  ['peerId(Qm…)', /(?<![A-Za-z0-9])Qm[1-9A-HJ-NP-Za-km-z]{30,}/],
  ['节点 multiaddr', /\/(ip4|ip6|dns4|dns6|dns|tcp|udp|ws|wss|quic|p2p-circuit|p2p)\b/],
  ['IPv4', /(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/],
];
const leaks = (t: string) => FORBIDDEN.filter(([, re]) => re.test(t)).map(([n]) => n);

function main() {
  fs.mkdirSync(BASE, { recursive: true });
  const A = h(BASE, 'A'), B = h(BASE, 'B'), C = h(BASE, 'C'), FRESH = h(BASE, 'fresh');
  for (const d of [A, B, C, FRESH]) fs.mkdirSync(d, { recursive: true });
  console.log(`隔离根目录: ${BASE}`);

  // ─────────────────────────── (B) identity init ───────────────────────────
  head('[B] bolloon identity init — 非交互 / 0600 / 字段一致 / 幂等 / 不打印私钥');

  const b1 = cli(A, ['identity', 'init', '--json']);
  check('全新 HOME: identity init exit 0 (无 TTY, stdin 关掉也不挂)', b1.code === 0, `exit=${b1.code}`);
  check('identity.json 已生成', fs.existsSync(idFile(A)));
  const modeA = fs.existsSync(idFile(A)) ? (fs.statSync(idFile(A)).mode & 0o777).toString(8) : '';
  check('文件模式 0600', modeA === '600', `实际=${modeA}`);
  const idA = fs.existsSync(idFile(A)) ? JSON.parse(fs.readFileSync(idFile(A), 'utf-8')) : {};
  check('字段与既有完全一致 (6 个)',
    JSON.stringify(Object.keys(idA).sort()) === JSON.stringify(['createdAt', 'did', 'keyType', 'privateKey', 'publicKey', 'version']),
    Object.keys(idA).join(','));
  check('keyType=Ed25519', idA.keyType === 'Ed25519', String(idA.keyType));
  check('退出码 0 且**绝不打印私钥** (stdout/stderr 里没有私钥值, 也没有 privateKey 字样)',
    !b1.out.includes(String(idA.privateKey)) && !b1.out.includes('privateKey') && !b1.err.includes(String(idA.privateKey)),
    `stdout 含 privateKey? ${b1.out.includes('privateKey')}`);

  const shaA0 = sha(idFile(A));
  const b2 = cli(A, ['identity', 'init']);
  check('幂等: 重跑 exit 0 且文件一字未改', b2.code === 0 && sha(idFile(A)) === shaA0,
    `exit=${b2.code} shaChanged=${sha(idFile(A)) !== shaA0}`);
  check('幂等: 重跑说明是复用而不是新建', /reused|已存在|未改动/.test(b2.out), b2.out.split('\n').filter(Boolean).slice(-4).join(' | '));

  const b3 = cli(A, ['identity', 'show', '--json']);
  const j3 = json(b3);
  check('identity show 出 DID 与公钥指纹', b3.code === 0 && !!j3?.data?.did && /^sha256:[0-9a-f]{16}$/.test(j3?.data?.fingerprint || ''));
  check('identity show 不含私钥', !b3.out.includes(String(idA.privateKey)) && !b3.out.includes('privateKey'));

  // 损坏文件不覆盖
  const scratch = h(BASE, 'corrupt'); fs.mkdirSync(scratch, { recursive: true });
  const badHome = h(scratch, 'home'); fs.mkdirSync(h(badHome, '.bolloon'), { recursive: true });
  fs.writeFileSync(idFile(badHome), '{"createdAt":"x","broken":', 'utf-8');
  const shaBad = sha(idFile(badHome));
  const b4 = cli(badHome, ['identity', 'init', '--json']);
  const j4 = json(b4);
  check('损坏的 identity.json → 拒绝覆盖 (非 0 退出 + 文件未被动过)',
    b4.code !== 0 && sha(idFile(badHome)) === shaBad && j4?.data?.action === 'refused',
    `exit=${b4.code} action=${j4?.data?.action}`);

  // ─────────────────────────── (A) task group ───────────────────────────
  head('[A] bolloon task group — 建群 / 另一进程可见 / 另一进程入群 / 取链接 / 退群');

  const g0 = cli(A, ['task', 'group', 'list', '--json']);
  const jg0 = json(g0);
  check('无群时 list → 空列表 (不是错误, 不崩)',
    g0.code === 0 && jg0?.data?.count === 0 && Array.isArray(jg0?.data?.groups) && jg0.data.groups.length === 0,
    `exit=${g0.code} count=${jg0?.data?.count}`);

  const gU = cli(A, ['task', 'group', '--json']);
  check('不带动作 → INVALID_ARGUMENT + 用法 (可发现性)', gU.code !== 0 && json(gU)?.code === 'INVALID_ARGUMENT');

  const g1 = cli(A, ['task', 'group', 'create', '--name', '接单群', '--json']);
  const jg1 = json(g1);
  const link = String(jg1?.data?.group?.link || '');
  const gid = String(jg1?.data?.group?.id || '');
  check('create exit 0', g1.code === 0, `exit=${g1.code} out=${g1.out.slice(0, 200)}`);
  check('create 打印了**邀请链接** (外部接单者靠它入群)', g1.out.includes(link) && /^orbitdb:\/\/\/orbitdb\/.+type=group/.test(link), link);
  check('欢迎消息的发送者是身份派生假名 (不是原始 DID)',
    /^agent-[0-9a-f]{8}$/.test(String(jg1?.data?.sender?.tag || '')) && !g1.out.includes(String(idA.did)) && !JSON.stringify(jg1).includes(String(idA.did)),
    String(jg1?.data?.sender?.tag));
  check('群名含标识符 → 拒建 (不静默改名)', (() => {
    const r = cli(A, ['task', 'group', 'create', '--name', 'did:diap:zTestAbc', '--json']);
    return r.code !== 0 && json(r)?.code === 'POLICY_DENIED';
  })());

  const g2 = cli(A, ['task', 'group', 'list', '--json']);
  const jg2 = json(g2);
  check('**另一进程** list 看得到刚建的群 (id 与 create 一致)',
    g2.code === 0 && jg2?.data?.count === 1 && jg2?.data?.groups?.[0]?.id === gid, `count=${jg2?.data?.count}`);
  check('list 不含链接/store 地址 (要链接走 group link), 且无 DID/peerId/节点 multiaddr/IP',
    !g2.out.includes(link) && !g2.out.includes('/orbitdb/') && !g2.out.includes(String(idA.did)) && leaks(g2.out).length === 0,
    `leaks=${leaks(g2.out).join(',')}`);

  const g3 = cli(A, ['task', 'group', 'link', gid, '--json']);
  check('group link <groupId> 显式取回链接 (与 create 逐字一致)', g3.code === 0 && json(g3)?.data?.group?.link === link);
  check('group link 未知 id → NOT_FOUND', cli(A, ['task', 'group', 'link', 'zdpuNoSuchGroup']).code !== 0);

  // 负控制: 空 HOME 拿不到区块 → 必须大声失败
  const n1 = cli(FRESH, ['task', 'group', 'join', link, '--json']);
  const jn1 = json(n1);
  check('**负控制**: 全新 HOME join 真链接 → 非 0 退出 + TRANSPORT_FAILED',
    n1.code !== 0 && jn1?.code === 'TRANSPORT_FAILED' && jn1?.data?.storeCode === 'STORE_UNREACHABLE',
    `exit=${n1.code} code=${jn1?.code} storeCode=${jn1?.data?.storeCode}`);
  check('**负控制**: 失败信封里带原始原因 (不是一句"失败了")',
    /block broker/i.test(String(jn1?.message || '')), String(jn1?.message || '').slice(0, 100));
  check('**负控制**: 没入群就不许出现在本地群列表 (没有"假装入群")',
    json(cli(FRESH, ['task', 'group', 'list', '--json']))?.data?.count === 0);
  check('join 非 orbitdb 的 URL → INVALID_ARGUMENT (与"本机没这个群"分开报)',
    json(cli(FRESH, ['task', 'group', 'join', 'https://example.invalid/x', '--json']))?.code === 'INVALID_ARGUMENT');

  // ───────── 第二个身份 (B): 自己的 HOME + 自己的 identity.json ─────────
  head('[K] 最关键: 第二个身份能不能往别人建的群里真发消息?');
  const k0 = cli(B, ['identity', 'init', '--json']);
  const idB = JSON.parse(fs.readFileSync(idFile(B), 'utf-8'));
  check('第二身份建出来了, 且与 A **不是同一个 DID** (真的另一个身份)',
    k0.code === 0 && !!idB.did && idB.did !== idA.did, `A=${String(idA.did).slice(0, 16)}… B=${String(idB.did).slice(0, 16)}…`);

  // 同机限定: 共享块存储目录 (否则第二个进程开不了同一个群 store) —— 见文件头
  fs.rmSync(h(B, '.bolloon', 'orbitdb'), { recursive: true, force: true });
  fs.symlinkSync(h(A, '.bolloon', 'orbitdb'), h(B, '.bolloon', 'orbitdb'));
  notes.push(`同机限定: B 的 ${h(B, '.bolloon', 'orbitdb')} → 软链到 A 的 orbitdb (共享块存储)`);
  console.log(`  ℹ️  同机限定: B 共享 A 的块存储目录 (${'orbitdb'} 软链) —— 只证同机跨进程`);

  const k1 = cli(B, ['task', 'group', 'join', link, '--json']);
  const jk1 = json(k1);
  check('**另一进程 + 另一身份** `task group join <链接>` exit 0 (自助入群)',
    k1.code === 0 && jk1?.ok === true && jk1?.data?.joined === true && jk1?.data?.already === false,
    `exit=${k1.code} joined=${jk1?.data?.joined}`);

  const k2 = cli(B, ['task', 'post', '--kind', 'deliver', '--group', link,
    '--announcement-id', 'ann-secondidentity01', '--hash', 'sha256:' + 'b'.repeat(64), '--bytes', '4096', '--json']);
  const jk2 = json(k2);
  const tagB = String(jk2?.data?.sender?.tag || '');
  check('**① ACL 不拦**: 第二个身份往群里发一条 (task post --kind deliver) → exit 0, 消息被接受',
    k2.code === 0 && jk2?.ok === true, `exit=${k2.code} code=${jk2?.code} err=${k2.err.slice(0, 120)}`);
  check('发送者标记是 B 自己的身份派生假名 (与 A 的假名不同 → 确实是另一个身份在发)',
    /^agent-[0-9a-f]{8}$/.test(tagB) && tagB !== String(jg1?.data?.sender?.tag), `A=${jg1?.data?.sender?.tag} B=${tagB}`);
  check('群消息里没有原始 DID (A/B 的都没有)', !k2.out.includes(String(idA.did)) && !k2.out.includes(String(idB.did)));

  // 实测: B 与 A **共享同一份 OrbitDB store 目录** → A 看得到 B 发的那条 (同机跨进程端到端成立)
  const k3 = cli(A, ['task', 'trail', '--group', link, '--json']);
  const jk3 = json(k3);
  const aSeesB = (jk3?.data?.timeline || []).some((e: any) => e.announcementId === 'ann-secondidentity01');
  check('A 用同一链接在新进程能读到**群本身** (trail 不报 store 不可达)', k3.code === 0 && !!jk3?.data,
    `exit=${k3.code} code=${jk3?.code}`);
  check('**② 建群者读得回**: A 的 trail 里有 B 以自己身份发的那条 (同机共享 store → 端到端成立)',
    aSeesB,
    aSeesB
      ? `timeline=${JSON.stringify((jk3?.data?.timeline || []).map((e: any) => e.announcementId))}`
      : `A 的 timeline 里没有 ann-secondidentity01 (${JSON.stringify((jk3?.data?.timeline || []).map((e: any) => e.announcementId))})`);

  // ───────── 另一个真正不同的 OrbitDB 写者身份 (C: 只共享 blocks) ─────────
  head('[K2] 更严的一档: 连 OrbitDB 写者身份都不同 (只共享 blocks, 自己的 log/keystore)');
  const c0 = cli(C, ['identity', 'init', '--json']);
  const idC = JSON.parse(fs.readFileSync(idFile(C), 'utf-8'));
  fs.mkdirSync(h(C, '.bolloon', 'orbitdb', 'ipfs'), { recursive: true });
  fs.symlinkSync(h(A, '.bolloon', 'orbitdb', 'ipfs', 'blocks'), h(C, '.bolloon', 'orbitdb', 'ipfs', 'blocks'));
  const c1 = cli(C, ['task', 'group', 'join', link, '--json']);
  const c2 = cli(C, ['task', 'post', '--kind', 'deliver', '--group', link,
    '--announcement-id', 'ann-ownlog00000001', '--hash', 'sha256:' + 'c'.repeat(64), '--json']);
  const jc2 = json(c2);
  check('三个身份 (A/B/C) 两两不同 DID', idA.did !== idB.did && idB.did !== idC.did && idA.did !== idC.did);
  check('C 入群 exit 0 (同链接)', c1.code === 0 && json(c1)?.data?.joined === true, `exit=${c1.code}`);
  check('**ACL 不拦异写者**: C (自己的 OrbitDB log/keystore) 发消息 → exit 0',
    c2.code === 0 && jc2?.ok === true, `exit=${c2.code} code=${jc2?.code}`);
  const c3 = cli(A, ['task', 'trail', '--group', link, '--json']);
  const aSeesC = (json(c3)?.data?.timeline || []).some((e: any) => e.announcementId === 'ann-ownlog00000001');
  check('**③ 但同机共享 ≠ 两台独立节点**: C (自己的 log/keystore) 那条 A **读不到** → 缺的是 log/块复制 (bitswap/block broker), 不是权限 → **跨机仍不行**',
    !aSeesC,
    aSeesC ? 'A 居然读到了 C 那条 —— 复制层可能已接上, 请更新口径' : 'A 只看得见自己那份 log (符合现状)');

  // ───────── leave ─────────
  head('[A] group leave — 只摘本机记录');
  const L1 = cli(B, ['task', 'group', 'leave', gid, '--json']);
  const jL1 = json(L1);
  check('leave exit 0 + 标记只改本机', L1.code === 0 && jL1?.data?.removed === true && jL1?.data?.localOnly === true);
  check('leave 后本机列表为空', json(cli(B, ['task', 'group', 'list', '--json']))?.data?.count === 0);
  check('再 leave → NOT_FOUND', cli(B, ['task', 'group', 'leave', gid, '--json']).code !== 0);

  // ─────────────────────────── 收尾 ───────────────────────────
  head('结果');
  if (notes.length) notes.forEach((n) => console.log(`  ℹ️  ${n}`));
  console.log(`  passed=${passed} failed=${failed} skipped=${skipped}`);
  if (failed) {
    console.log('\n失败项:');
    fails.forEach((f) => console.log(`  · ${f}`));
  }
  console.log(`\n隔离目录保留以便复查: ${BASE}`);
  console.log(`EXITCODE=${failed ? 1 : 0}`);
  process.exit(failed ? 1 : 0);
}

try { main(); } catch (e: any) {
  console.error('验收脚本自身抛错:', e?.stack || e);
  process.exit(1);
}
