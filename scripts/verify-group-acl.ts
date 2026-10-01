/**
 * verify-group-acl.ts — P1 门: 群写入权限的 **DID 门控** (2026-10-01)
 * ==========================================================================
 * 为什么要有这道门: 之前全仓的"群权限"从来没被真两节点验过 —— 5 个多节点测试都注入
 * fake CIDDatabase (fake 里 `add` 永远成功), 于是"非成员写不进去"这件事**从来没有证据**。
 * 本门起**真子进程**(每个 = 一个真 helia/libp2p/OrbitDB 节点, 各自 HOME/身份/随机端口),
 * 走真 dial + 真 pubsub + 真 bitswap 块交换, 把结论**真跑出来**。
 *
 * 三条硬要求 → 五个真跑的场景:
 *   S1  A 用 DID 门控建群 (白名单 = 群主 + 成员 B 的 OrbitDB 写身份); 报告真地址/白名单
 *   S2  **成员** B 真写入 ⇒ 必须成功 (阳性对照: 同一段代码在 S3 会失败, 所以不是"门自己没检查")
 *   S3  **非成员** C 真写入 ⇒ 必须被拒。三重独立证据, 不靠"门说它拒了":
 *         a) 错误原文来自 OrbitDB 自己 ("Key … is not allowed to write to the log")
 *         b) C 的日志长度**没有增长** (append 若成功必然增长)
 *         c) C 的正文**不在**收敛后的日志里 (文本指纹与成员侧逐字相同)
 *   S4  成员变更是一条**双侧 Ed25519 验签**的群事件 (成员自签 + 群主签);
 *       篡改 (换 orbitdbId / 改 op / 坏签名) 必须验不过
 *   S5  **白名单变更 = 重建 store**: 把 S4 的事件真正应用 ⇒ 新地址白名单含 C ⇒ C 在新地址能写;
 *       同时老地址**仍然**拒 C (老地址的白名单不可追认)。重建的代价逐条打印 (aclChangePlan)
 *
 * 跑法: npx tsx scripts/verify-group-acl.ts
 *   (父进程 = 启动器 + 判据; 子进程 = 自己, 用 `--child <spec.json>` 重新 exec)
 * 判据来源: 子进程 stdout 的 `@@OUT {json}` 行 —— 父进程只信这些真输出, 不认识就报不认识。
 *
 * 两个从 P0 门继承的硬教训 (别重踩):
 *   ① 供块的节点必须**活着** —— 阶段结束就退出的节点, 对端只会拿到 ECONNREFUSED /
 *      "Failed to load block"。写者尤其要 hold: 对端要拉它的 **identity 块**才能验签它写的条目
 *      (canAppend → identities.getIdentity → bitswap)。2026-10-01 实测: 写者一退出,
 *      其余节点报 "Failed to load block for bafyrei…"。
 *   ② 拨号地址只挑 127.0.0.1 —— 本机 ClashX fake-ip 会混进 100.100.x / 198.18.x 假地址。
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { GroupGateInput } from '../src/agents/gateway-group.js';
import type { MemberRef, MembershipStatement, MembershipEvent } from '../src/orbitdb/group-access.js';

const REPO = process.cwd();
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const SELF = path.join(REPO, 'scripts', 'verify-group-acl.ts');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-p1-acl-'));
const HOLD_MS = 240000;

// ================================================================= 子进程模式

interface ChildSpec {
  home: string;
  phase: 'identity' | 'sign' | 'create' | 'send';
  agentId?: string;
  // sign
  role?: 'member' | 'admin';
  statement?: unknown;
  // create
  tag?: string;
  owner?: unknown;
  members?: unknown[];
  membershipEvents?: unknown[];
  hello?: string;
  // send
  dial?: string[];
  targets?: Array<{ link: string; count: number; from: string; textPrefix: string; wantSeen?: number }>;
  holdMs?: number;
}

async function runChild(spec: ChildSpec): Promise<void> {
  const out = (o: Record<string, unknown>): void => { process.stdout.write('@@OUT ' + JSON.stringify(o) + '\n'); };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const loopback = (a: unknown): string[] =>
    (Array.isArray(a) ? (a as string[]) : []).filter((x) => x.includes('/ip4/127.0.0.1/tcp/')).slice(0, 1);

  const GG: typeof import('../src/agents/gateway-group.js') = await import('../src/agents/gateway-group.js');
  const access: typeof import('../src/orbitdb/group-access.js') = await import('../src/orbitdb/group-access.js');
  const { loadOrCreateAgentIdentity } = await import('../src/agents/agent-identity.js');
  const { getCIDDatabase } = await import('../src/orbitdb/cid-database.js');

  const agentId = spec.agentId || 'group-acl-gate';

  // --- sign: 只需要本机 agent 身份 (Ed25519), **不起 OrbitDB** (同一 HOME 可能正被常驻节点占着) ---
  if (spec.phase === 'sign') {
    const idn = loadOrCreateAgentIdentity(agentId);
    const stmt = spec.statement as MembershipStatement;
    const sig = spec.role === 'admin'
      ? await access.signAsAdmin(stmt, idn.privateKey)
      : await access.signAsMember(stmt, idn.privateKey);
    out({ phase: 'sign', role: spec.role, sig, did: idn.did, publicKeyHex: idn.publicKey });
    process.exit(0);
  }

  // --- 其余相位都要真节点 ---
  const db = getCIDDatabase();
  // 触发懒初始化 (singleton 的 ensure()) —— 之后才能读 orbitdb 句柄 / 拨号 / 听地址
  await db.openStore('bolloon-cid-store', 'keyvalue');
  const odb = (db as unknown as { orbitdb?: { identity: { id: string } }; listenAddrs?: () => string[] });
  const orbitdbId = odb.orbitdb?.identity.id || '';
  const idn = loadOrCreateAgentIdentity(agentId);

  if (spec.phase === 'identity') {
    out({ phase: 'identity', orbitdbId, did: idn.did, publicKeyHex: idn.publicKey, addrs: loopback(odb.listenAddrs?.() ?? []) });
    process.exit(0);
  }

  if (spec.phase === 'create') {
    const gate: GroupGateInput = {
      owner: spec.owner as MemberRef,
      members: (spec.members ?? []) as MemberRef[],
      membershipEvents: (spec.membershipEvents ?? []) as MembershipEvent[],
    };
    const r = await GG.createGroup(String(spec.tag), {
      from: gate.owner.did,
      hello: spec.hello || `📢 门控群「${spec.tag}」已建 (DID 门控)`,
      gate,
    });
    if (!r.ok || !r.group) {
      out({ phase: 'create', ok: false, error: r.error || 'createGroup 失败 (无原因)' });
      await db.close(); process.exit(1);
    }
    const ev = await GG.groupMembershipEvents(r.group.id);
    out({
      phase: 'create', ok: true,
      tag: spec.tag,
      address: r.group.address, link: r.group.link, id: r.group.id,
      gated: r.group.gated === true, ownerDid: r.group.ownerDid, aclWrite: r.group.aclWrite ?? [],
      membershipAccepted: ev.accepted.length, membershipRejected: ev.rejected.length,
      messages: (await GG.groupMessages(r.group.id, 500)).map((m) => m.text),
      addrs: loopback(odb.listenAddrs?.() ?? []), orbitdbId,
    });
    const ms = spec.holdMs ?? 0;
    if (ms > 0) { await sleep(ms); }
    await db.close(); process.exit(0);
  }

  // --- send: 拨号 → join (读) → 逐目标尝试写 → 报真实结果 ---
  const dialOnce = async (addrs: string[]): Promise<{ dialed: string[]; dialErrors: string[] }> => {
    const dialed: string[] = [];
    const dialErrors: string[] = [];
    for (const a of addrs) {
      if (!a) continue;
      try { await (db as unknown as { dial: (x: string) => Promise<void> }).dial(a); dialed.push(a); }
      catch (e: any) { dialErrors.push(`${a} → ${String(e?.message || e).slice(0, 100)}`); }
    }
    return { dialed, dialErrors };
  };
  const firstDial = await dialOnce(spec.dial ?? []);
  const allDialed = [...firstDial.dialed];
  const allDialErrors = [...firstDial.dialErrors];
  // 拨号后给连接一点时间; 块交换在连接刚建立时会 want-abort (实测: 刚重启的供块方尤其明显)
  if (allDialed.length) await sleep(2500);

  const results: Array<Record<string, unknown>> = [];
  for (const t of spec.targets ?? []) {
    const res: Record<string, unknown> = { link: t.link, textPrefix: t.textPrefix };
    // join 可重试: STORE_UNREACHABLE 多为对端块还没拉到 (环境问题), 不当作 ACL 结论
    let j = await GG.joinGroup(t.link);
    const attempts: string[] = [];
    for (let k = 0; k < 3 && !j.ok; k++) {
      attempts.push(shortErr(j.error || j.code || 'unknown'));
      const rd = await dialOnce(spec.dial ?? []);
      allDialErrors.push(...rd.dialErrors);
      await sleep(4000);
      j = await GG.joinGroup(t.link);
    }
    res.joinOk = j.ok === true;
    res.groupId = j.group?.id ?? null;
    res.openAttempts = attempts;
    if (!j.ok || !j.group) {
      res.openOk = false; res.openError = j.error || j.code || 'joinGroup 失败';
      results.push(res); continue;
    }
    const gid = j.group.id;
    const want = t.wantSeen ?? 1;
    const t0 = Date.now();
    let msgs: Array<{ from: string; text: string; ts: number }> = [];
    try { msgs = await GG.groupMessages(gid, 500); }
    catch (e: any) {
      res.openOk = false;
      res.openError = `groupMessages 抛错 (读不到 ≠ 没有): ${String(e?.message || e).slice(0, 160)}`;
      results.push(res); continue;
    }
    while (msgs.length < want && Date.now() - t0 < 60000) {
      await sleep(1000);
      try { msgs = await GG.groupMessages(gid, 500); } catch { /* 读失败保持上一次 */ }
    }
    res.openOk = true;
    res.openError = null;
    res.waitedMs = Date.now() - t0;
    res.before = msgs.length;
    res.converged = msgs.length >= want;
    const errors: string[] = [];
    let wrote = 0;
    for (let i = 0; i < t.count; i++) {
      const r = await GG.groupSend(gid, `${t.textPrefix}#${i}`, t.from);
      if (r.ok) wrote++;
      else { errors.push(String(r.error || '未知失败')); break; }
    }
    res.wrote = wrote;
    res.errors = errors;
    const after = await GG.groupMessages(gid, 500);
    res.after = after.length;
    res.grewBy = after.length - msgs.length;
    const texts = after.map((m) => m.text).sort();
    res.texts = texts;
    res.textsHash = crypto.createHash('sha256').update(texts.join('\n')).digest('hex').slice(0, 16);
    res.froms = Array.from(new Set(after.map((m) => m.from))).sort();
    results.push(res);
  }
  out({ phase: 'send', results, dialed: allDialed, dialErrors: allDialErrors, addrs: loopback(odb.listenAddrs?.() ?? []), orbitdbId, peerId: (db as unknown as { peerId?: string }).peerId ?? null });
  const ms = spec.holdMs ?? 0;
  if (ms > 0) await sleep(ms);
  await db.close(); process.exit(0);
}

// ================================================================= 父进程模式

interface Res { ok?: boolean; [k: string]: any }
interface Bg { kill: () => void; result: Promise<Res> }

const live: ChildProcess[] = [];

function startNode(home: string, spec: Record<string, unknown>, timeoutMs = 300000) {
  fs.mkdirSync(home, { recursive: true });
  const specPath = path.join(home, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({ home, ...spec }));
  const p = spawn(TSX, [SELF, '--child', specPath], { cwd: REPO, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  live.push(p);
  let out = '';
  let err = '';
  let first: Res | null = null;
  let resolveFirst: ((r: Res) => void) | null = null;
  const firstP = new Promise<Res>((r) => { resolveFirst = r; });
  const onLine = (line: string): void => {
    if (!line.startsWith('@@OUT ')) return;
    try {
      const obj = JSON.parse(line.slice(6)) as Res;
      if (!first) { first = obj; resolveFirst?.(obj); }
    } catch { /* 忽略坏行 */ }
  };
  p.stdout.on('data', (d) => { const s = d.toString(); out += s; for (const l of s.split('\n')) onLine(l); });
  p.stderr.on('data', (d) => { err += d.toString(); });
  const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* 忽略 */ } }, timeoutMs);
  const closed = new Promise<Res>((resolve) => {
    p.on('close', () => {
      clearTimeout(timer);
      if (first) return resolve(first);
      const line = out.split('\n').find((l) => l.startsWith('@@OUT '));
      if (!line) return resolve({ ok: false, fatal: 'child 没输出 @@OUT', stderrTail: err.split('\n').slice(-4).join(' | ').slice(0, 400) });
      try { resolve(JSON.parse(line.slice(6))); } catch (e) { resolve({ ok: false, fatal: `解析 @@OUT 失败: ${String(e)}` }); }
    });
  });
  return { first: firstP, closed, kill: () => { try { p.kill('SIGTERM'); } catch { /* 忽略 */ } } };
}

async function runNode(home: string, spec: Record<string, unknown>, timeoutMs = 300000): Promise<Res> {
  return startNode(home, spec, timeoutMs).closed;
}
function holdNode(home: string, spec: Record<string, unknown>, timeoutMs = 300000): Bg {
  const n = startNode(home, { ...spec, holdMs: HOLD_MS }, timeoutMs);
  return { kill: n.kill, result: n.first };
}

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail: string): void { checks.push({ name, pass, detail }); }
const short = (s: unknown, n = 110) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const shortErr = (s: unknown, n = 90) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const ACL_REJECT_RE = /not allowed to write to the log/i;

async function main(): Promise<void> {
  const access: typeof import('../src/orbitdb/group-access.js') = await import('../src/orbitdb/group-access.js');
  console.log('P1 · 群写入权限 DID 门控 (真两节点验收)');
  console.log(`   节点根目录: ${ROOT}   每节点独立 HOME (身份/blockstore/随机端口); 写者全程 hold 供块`);
  console.log('');

  const home = { a: path.join(ROOT, 'a'), b: path.join(ROOT, 'b'), c: path.join(ROOT, 'c') };

  // ---- 0. 三节点身份 (真 helia 节点 → 真 OrbitDB 写身份 id + 真 agent DID) ----
  const idA = await runNode(home.a, { phase: 'identity' });
  const idB = await runNode(home.b, { phase: 'identity' });
  const idC = await runNode(home.c, { phase: 'identity' });
  console.log('   0 · 三节点身份');
  for (const [n, r] of [['A', idA], ['B', idB], ['C', idC]] as const) {
    console.log(`      ${n}: orbitdb写身份=${short(r.orbitdbId, 20)}… did=${short(r.did, 24)}… dial=${short(r.addrs?.[0], 60)}`);
  }
  check('三节点身份齐全 (真 OrbitDB 写身份 + 真 did:key)',
    [idA, idB, idC].every((r) => /^0[23][0-9a-f]{64}$/.test(String(r.orbitdbId)) && String(r.did).startsWith('did:key:z')),
    `A=${short(idA.orbitdbId, 12)}… B=${short(idB.orbitdbId, 12)}… C=${short(idC.orbitdbId, 12)}…`);
  console.log('');

  const refA = { did: idA.did, publicKeyHex: idA.publicKeyHex, orbitdbId: idA.orbitdbId };
  const refB = { did: idB.did, publicKeyHex: idB.publicKeyHex, orbitdbId: idB.orbitdbId };
  const refC = { did: idC.did, publicKeyHex: idC.publicKeyHex, orbitdbId: idC.orbitdbId };

  // ---- S1: A 用 DID 门控建群 (白名单 = A + B; 不含 C) ----
  const a1 = holdNode(home.a, {
    phase: 'create', tag: 'acl-v1', owner: refA, members: [refB], membershipEvents: [],
  });
  const A1 = await a1.result;
  console.log('   S1 · A 建 DID 门控群 v1 (白名单 = A + B)');
  console.log(`      地址: ${A1.address}`);
  console.log(`      白名单 (manifest 里烧进去的): ${JSON.stringify(A1.aclWrite)}`);
  console.log(`      gated=${A1.gated} ownerDid=${short(A1.ownerDid, 26)}… 拨号=${short(A1.addrs?.[0], 60)}`);
  if (A1.error) console.log(`      建群失败: ${short(A1.error)}`);
  check('S1 建群成功且是门控群',
    A1.ok === true && A1.gated === true && String(A1.address || '').startsWith('/orbitdb/'),
    `ok=${A1.ok} gated=${A1.gated} address=${short(A1.address, 40)}`);
  check('S1 白名单含 A 与 B、**不含** C (C 还没加入)',
    Array.isArray(A1.aclWrite) && A1.aclWrite.includes(refA.orbitdbId) && A1.aclWrite.includes(refB.orbitdbId) && !A1.aclWrite.includes(refC.orbitdbId),
    `aclWrite=${JSON.stringify(A1.aclWrite)}`);
  console.log('');

  // ---- S4a: 造"加入 C"的可验签成员事件 (绑定到 v1 地址) ----
  const stmt = access.buildMembershipStatement({
    group: String(A1.address), op: 'add', member: refC,
    by: { did: refA.did, publicKeyHex: refA.publicKeyHex }, ts: Date.now(),
  });
  console.log('   S4 · 成员变更事件 (成员自签 + 群主签)');
  console.log(`      正文: op=${stmt.op} group=${short(stmt.group, 40)} member.did=${short(stmt.member.did, 24)}… member.orbitdbId=${short(stmt.member.orbitdbId, 20)}…`);
  const sigC = await runNode(home.c, { phase: 'sign', role: 'member', statement: stmt });
  const sigA = await runNode(home.a, { phase: 'sign', role: 'admin', statement: stmt });
  const ev = access.assembleMembershipEvent(stmt, { memberSig: String(sigC.sig), adminSig: String(sigA.sig) });
  const vEv = await access.verifyMembershipEvent(ev, { group: String(A1.address) });
  console.log(`      成员签 (C): ${short(sigC.sig, 32)}…   群主签 (A): ${short(sigA.sig, 32)}…`);
  console.log(`      验签结果: ok=${vEv.ok} — ${vEv.checks.map((c) => `${c.name}=${c.ok ? '✓' : '✗'}`).join(' ')}`);
  check('S4a 成员事件双侧验签通过 (真 Ed25519, 成员 + 群主)',
    vEv.ok === true, vEv.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | ') || '全部 check 通过');

  const evSwap = { ...ev, member: { ...ev.member, orbitdbId: '02' + crypto.randomBytes(32).toString('hex') } };
  const vSwap = await access.verifyMembershipEvent(evSwap, { group: String(A1.address) });
  const evOp = { ...ev, op: 'remove' as const };
  const vOp = await access.verifyMembershipEvent(evOp, { group: String(A1.address) });
  const evBadSig = { ...ev, adminSig: ev.adminSig.slice(0, -6) + 'AAAAAA' };
  const vBadSig = await access.verifyMembershipEvent(evBadSig, { group: String(A1.address) });
  check('S4b 篡改 orbitdbId → 验签失败', vSwap.ok === false, `ok=${vSwap.ok} 失败项=${vSwap.checks.filter((c) => !c.ok).map((c) => c.name).join(',')}`);
  check('S4c 改 op (add→remove) → 两枚签名都失效', vOp.ok === false && vOp.checks.filter((c) => !c.ok).map((c) => c.name).join(',') === 'adminSig,memberSig',
    `ok=${vOp.ok} 失败项=${vOp.checks.filter((c) => !c.ok).map((c) => c.name).join(',')}`);
  check('S4d 坏签名 → 验签失败', vBadSig.ok === false, `ok=${vBadSig.ok} 失败项=${vBadSig.checks.filter((c) => !c.ok).map((c) => c.name).join(',')}`);
  console.log('');

  // ---- S2: 成员 B 真写入 (阳性对照) ----
  const b1 = holdNode(home.b, {
    phase: 'send',
    dial: [String(A1.addrs?.[0] || '')].filter(Boolean),
    targets: [{ link: String(A1.link), count: 2, from: 'B', textPrefix: 'b-msg', wantSeen: 1 }],
  });
  const B1 = await b1.result;
  const rB = (B1.results ?? [])[0] ?? {};
  console.log('   S2 · 成员 B 写入 (阳性对照)');
  console.log(`      openOk=${rB.openOk} seen=${rB.before}→${rB.after} (grewBy=${rB.grewBy}) wrote=${rB.wrote} errors=${JSON.stringify(rB.errors)}`);
  console.log(`      拨号: dialed=${JSON.stringify(B1.dialed)} dialErrors=${JSON.stringify(B1.dialErrors)}`);
  if (rB.openError) console.log(`      打开失败: ${short(rB.openError)}`);
  console.log(`      B 侧文本指纹=${rB.textsHash}  消息=${JSON.stringify(rB.texts)}`);
  check('S2 成员 B 打开成功且拿到历史', rB.openOk === true && Number(rB.before) >= 1, `openOk=${rB.openOk} before=${rB.before}`);
  check('S2 成员 B 写入成功 (门控群对成员放行)', Number(rB.wrote) === 2 && (rB.errors ?? []).length === 0,
    `wrote=${rB.wrote} errors=${JSON.stringify(rB.errors)}`);
  check('S2 阳性对照成立: 成员写入**真的让日志增长** (所以 S3 的"没增长"是有信息的)',
    Number(rB.grewBy) === 2, `grewBy=${rB.grewBy} (期望 2)`);
  console.log('');

  // ---- S3: 非成员 C 尝试写入 (反事实) ----
  const c1 = await runNode(home.c, {
    phase: 'send',
    dial: [String(A1.addrs?.[0] || ''), String((B1.addrs ?? [])[0] || '')].filter(Boolean),
    targets: [{ link: String(A1.link), count: 1, from: 'C-NONMEMBER', textPrefix: 'intrusion', wantSeen: 3 }],
  });
  const rC = (c1.results ?? [])[0] ?? {};
  console.log('   S3 · 非成员 C 打开 (读) + 尝试写入 (反事实)');
  console.log(`      openOk=${rC.openOk} 等到 ${rC.before} 条 (converged=${rC.converged}, ${rC.waitedMs}ms)`);
  console.log(`      wrote=${rC.wrote}  after=${rC.after} (grewBy=${rC.grewBy})`);
  console.log(`      错误原文: ${short((rC.errors ?? [])[0])}`);
  console.log(`      C 侧文本指纹=${rC.textsHash}  froms=${JSON.stringify(rC.froms)}`);
  console.log(`      拨号: dialed=${JSON.stringify(c1.dialed)} dialErrors=${JSON.stringify(c1.dialErrors)}`);
  check('S3 非成员 C **能打开并读到既有历史** (读得到 ≠ 写得了)', rC.openOk === true && Number(rC.before) >= 3, `openOk=${rC.openOk} before=${rC.before} (期望 ≥3)`);
  check('S3 非成员 C 写入**被拒** (错误来自 OrbitDB 自己)', Number(rC.wrote) === 0 && ACL_REJECT_RE.test(String((rC.errors ?? [])[0] || '')),
    `wrote=${rC.wrote} err=${short((rC.errors ?? [])[0], 90)}`);
  check('S3 拒绝**真的生效**: C 的日志长度没增长 (append 若成功必然增长)', Number(rC.grewBy) === 0, `grewBy=${rC.grewBy} (期望 0)`);
  check('S3 C 的正文**不在**收敛后的日志里, 且两侧文本指纹逐字相同',
    !(rC.texts ?? []).some((t: string) => String(t).startsWith('intrusion')) && rC.textsHash === rB.textsHash,
    `文本指纹 B=${rB.textsHash} C=${rC.textsHash}`);
  console.log('');

  // ---- S5: 真正应用成员变更 = 重建 store (IPFS 型 AC 不能就地改) ----
  const plan = access.aclChangePlan({ before: A1.aclWrite ?? [], after: [...(A1.aclWrite ?? []), refC.orbitdbId], messageCount: Number(rB.after ?? 0) });
  console.log('   S5 · 应用成员变更 = 重建 store (IPFS 型 AC 的白名单不可就地改)');
  console.log(`      ACL 就地更新能力: ipfsType.inPlace=${access.ACL_INPLACE_UPDATE.ipfsType.inPlace} / orbitdbType.inPlace=${access.ACL_INPLACE_UPDATE.orbitdbType.inPlace}`);
  console.log(`      为什么: ${access.ACL_INPLACE_UPDATE.ipfsType.why}`);
  console.log('      重建代价 (aclChangePlan):');
  for (const c of plan.costs) console.log(`        · ${c}`);
  a1.kill(); b1.kill();
  await new Promise((r) => setTimeout(r, 2500)); // 让同 HOME 的 LevelDB 释放

  const a2 = holdNode(home.a, {
    phase: 'create', tag: 'acl-v2', owner: refA, members: [refB], membershipEvents: [ev],
    hello: '📢 门控群 v2 (已把 C 的成员事件真正应用)',
  });
  const A2 = await a2.result;
  console.log(`      v1 地址: ${A1.address}`);
  console.log(`      v2 地址: ${A2.address}`);
  console.log(`      v2 白名单: ${JSON.stringify(A2.aclWrite)}`);
  console.log(`      v2 落库的成员事件: accepted=${A2.membershipAccepted} rejected=${A2.membershipRejected}`);
  console.log(`      v2 拨号地址: ${short(A2.addrs?.[0], 70)}`);
  if (A2.error) console.log(`      建群失败: ${short(A2.error)}`);
  check('S5a 重建后新地址白名单**含 C** (事件真被应用)', Array.isArray(A2.aclWrite) && A2.aclWrite.includes(refC.orbitdbId),
    `aclWrite=${JSON.stringify(A2.aclWrite)}`);
  check('S5b 重建**换了地址** (这就是代价, 不是免费的)', !!A2.address && A2.address !== A1.address, `v1=${short(A1.address, 30)} v2=${short(A2.address, 30)}`);
  check('S5c 重建时事件被**重新验签**后落库 (accepted=1, rejected=0)', Number(A2.membershipAccepted) === 1 && Number(A2.membershipRejected) === 0,
    `accepted=${A2.membershipAccepted} rejected=${A2.membershipRejected}`);

  // ---- S5d: C 在**新地址**能写; 在**老地址**仍被拒 ----
  const c2 = await runNode(home.c, {
    phase: 'send',
    dial: [String(A2.addrs?.[0] || '')].filter(Boolean),
    targets: [
      { link: String(A2.link), count: 2, from: 'C', textPrefix: 'c-now-member', wantSeen: 1 },
      { link: String(A1.link), count: 1, from: 'C', textPrefix: 'still-blocked', wantSeen: 3 },
    ],
  });
  const rC2v2 = (c2.results ?? [])[0] ?? {};
  const rC2v1 = (c2.results ?? [])[1] ?? {};
  console.log('   S5d · C 在重建后的新地址 vs 老地址');
  console.log(`      v2: openOk=${rC2v2.openOk} wrote=${rC2v2.wrote} after=${rC2v2.after} errors=${JSON.stringify(rC2v2.errors)}`);
  console.log(`      v1: openOk=${rC2v1.openOk} wrote=${rC2v1.wrote} after=${rC2v1.after} errors=${JSON.stringify((rC2v1.errors ?? []).map((e: string) => short(e, 90)))}`);
  console.log(`      拨号: dialed=${JSON.stringify(c2.dialed)} dialErrors=${JSON.stringify(c2.dialErrors)}`);
  if (rC2v2.openAttempts?.length) console.log(`      v2 打开重试记录: ${JSON.stringify(rC2v2.openAttempts)}`);
  if (rC2v2.openError) console.log(`      v2 打开失败: ${short(rC2v2.openError, 200)}`);
  if (rC2v1.openError) console.log(`      v1 打开失败: ${short(rC2v1.openError, 200)}`);
  check('S5d C 在**新地址**能写 (成员变更生效)', Number(rC2v2.wrote) === 2 && (rC2v2.errors ?? []).length === 0,
    `wrote=${rC2v2.wrote} errors=${JSON.stringify(rC2v2.errors)}`);
  check('S5e C 在**老地址**仍被拒 (老地址白名单不可追认, 老链接作废)',
    Number(rC2v1.wrote) === 0 && ACL_REJECT_RE.test(String((rC2v1.errors ?? [])[0] || '')),
    `wrote=${rC2v1.wrote} err=${short((rC2v1.errors ?? [])[0], 90)}`);
  console.log('');

  a2.kill();

  // ---- 判据汇总 ----
  const bad = checks.filter((c) => !c.pass);
  console.log('   判据:');
  for (const c of checks) console.log(`      ${c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`);
  console.log('');
  console.log(`   结论: ${checks.length - bad.length}/${checks.length} 通过` + (bad.length ? ' —— 有真失败, 见上' : ''));
  console.log(`   节点数据留档: ${ROOT}`);
  for (const p of live) { try { p.kill('SIGTERM'); } catch { /* 忽略 */ } }
  if (!bad.length) { try { fs.rmSync(ROOT, { recursive: true, force: true }); console.log('   (全绿, 临时节点目录已清理)'); } catch { /* 忽略 */ } }
  process.exit(bad.length ? 1 : 0);
}

// ================================================================= 入口

const argv = process.argv.slice(2);
if (argv[0] === '--child') {
  const specPath = argv[1];
  if (!specPath) { console.error('用法: verify-group-acl.ts --child <spec.json>'); process.exit(2); }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as ChildSpec;
  void runChild(spec).catch((e: any) => {
    process.stdout.write('@@OUT ' + JSON.stringify({ ok: false, fatal: String(e?.message || e).slice(0, 300) }) + '\n');
    process.exit(1);
  });
} else {
  void main().catch((e: any) => {
    console.error('父进程异常:', e?.stack || e);
    for (const p of live) { try { p.kill('SIGTERM'); } catch { /* 忽略 */ } }
    process.exit(1);
  });
}
