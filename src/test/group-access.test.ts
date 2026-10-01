/**
 * group-access.test.ts — DID 门控的**纯函数**测试 (2026-10-01, P1)
 *
 * 这里只测不碰网络的逻辑: 成员声明的形状/绑定校验、**真 Ed25519 双侧验签**、
 * 篡改必须被发现、白名单派生确定性、ACL 选项与"必须重建"的代价清单。
 *
 * 真两节点验收 (非成员写入被拒/成员写入通过) 在 `scripts/verify-group-acl.ts`,
 * 这里不用 fake 冒充它 —— 单测绿 ≠ 复制能过。
 */
import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { KeyManager } from '@diap/sdk';
import {
  GROUP_MEMBERSHIP_PROTOCOL,
  GROUP_MEMBERSHIP_KIND,
  buildMembershipStatement,
  membershipSigningPayload,
  signAsMember,
  signAsAdmin,
  assembleMembershipEvent,
  createMembershipEvent,
  verifyMembershipEvent,
  statementOfEvent,
  applyMembershipEvents,
  membershipEntryOf,
  writeListAllows,
  normalizeWriteList,
  groupAccessOptions,
  aclChangePlan,
  ACL_INPLACE_UPDATE,
  type MemberRef,
  type MembershipEvent,
  type MembershipStatement,
} from '../orbitdb/group-access.js';
import { didFromEd25519PublicKey } from '../agents/identity/address-binding.js';

/** 造一个成员: KeyManager 出真 Ed25519 (DID 同一把钥匙), orbitdbId 造成 66 位合法形状 */
function mkMember(tag: string): { ref: MemberRef; priv: string } {
  const kp = KeyManager.generate();
  const publicKeyHex = Buffer.from(kp.publicKey).toString('hex');
  const orbitdbId = '02' + crypto.createHash('sha256').update('orbitdb:' + tag).digest('hex');
  return {
    ref: { did: kp.did, publicKeyHex, orbitdbId },
    priv: Buffer.from(kp.privateKey).toString('hex'),
  };
}

const GROUP = '/orbitdb/zdpuTestGroupAddressAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function makeAddEvent(owner: { ref: MemberRef; priv: string }, m: { ref: MemberRef; priv: string }, ts = 1000) {
  const stmt = buildMembershipStatement({ group: GROUP, op: 'add', member: m.ref, by: { did: owner.ref.did, publicKeyHex: owner.ref.publicKeyHex }, ts });
  return createMembershipEvent({ statement: stmt, memberPrivateKeyHex: m.priv, adminPrivateKeyHex: owner.priv });
}

describe('group-access (DID 门控 · 纯函数)', () => {
  // ---------- 形状 / 绑定 ----------

  it('buildMembershipStatement: group 必须是 /orbitdb/ 地址', () => {
    const owner = mkMember('o');
    const m = mkMember('m');
    expect(() => buildMembershipStatement({ group: 'bolloon-gw-group-x', op: 'add', member: m.ref, by: { did: owner.ref.did, publicKeyHex: owner.ref.publicKeyHex } }))
      .toThrow(/group 必须是 \/orbitdb\//);
  });

  it('buildMembershipStatement: op 只能是 add|remove', () => {
    const owner = mkMember('o2');
    const m = mkMember('m2');
    expect(() => buildMembershipStatement({ group: GROUP, op: 'grant' as any, member: m.ref, by: { did: owner.ref.did, publicKeyHex: owner.ref.publicKeyHex } }))
      .toThrow(/op 必须是 add\|remove/);
  });

  it('buildMembershipStatement: did 与 publicKeyHex 必须是同一把钥匙', () => {
    const owner = mkMember('o3');
    const m = mkMember('m3');
    const other = mkMember('x3');
    expect(() => buildMembershipStatement({ group: GROUP, op: 'add', member: { ...m.ref, did: other.ref.did }, by: { did: owner.ref.did, publicKeyHex: owner.ref.publicKeyHex } }))
      .toThrow(/同一把钥匙/);
  });

  it('buildMembershipStatement: orbitdbId 形状非法要拒 (DID 字符串放进去会被拒)', () => {
    const owner = mkMember('o4');
    const m = mkMember('m4');
    // 把 DID 当成写身份传进去 —— 必须被形状校验拦住
    expect(() => buildMembershipStatement({ group: GROUP, op: 'add', member: { ...m.ref, orbitdbId: m.ref.did }, by: { did: owner.ref.did, publicKeyHex: owner.ref.publicKeyHex } }))
      .toThrow(/orbitdbId 形状非法/);
  });

  it('成员 DID 与 address-binding 的 didFromEd25519PublicKey 逐字一致 (没有第二套派生)', () => {
    const m = mkMember('m5');
    expect(m.ref.did).toBe(didFromEd25519PublicKey(m.ref.publicKeyHex));
  });

  // ---------- 真验签 ----------

  it('合法事件: 双侧验签通过, 每一项 check 都 ok', async () => {
    const owner = mkMember('oa');
    const m = mkMember('ma');
    const ev = await makeAddEvent(owner, m);
    const r = await verifyMembershipEvent(ev, { group: GROUP });
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['protocol', 'op', 'group', 'ts', 'member-binding', 'by-binding', 'adminSig', 'memberSig', 'group-match'])
    );
  });

  it('篡改 adminSig → 验签必须失败 (不是"看起来像就行")', async () => {
    const owner = mkMember('ob');
    const m = mkMember('mb');
    const ev = await makeAddEvent(owner, m);
    const bad = { ...ev, adminSig: ev.adminSig.slice(0, -4) + (ev.adminSig.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    const r = await verifyMembershipEvent(bad);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'adminSig')?.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'memberSig')?.ok).toBe(true); // 只有发起人那枚被改
  });

  it('篡改 memberSig → 验签必须失败 (成员没同意就不算数)', async () => {
    const owner = mkMember('oc');
    const m = mkMember('mc');
    const ev = await makeAddEvent(owner, m);
    const bad = { ...ev, memberSig: ev.memberSig.slice(0, -4) + (ev.memberSig.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    const r = await verifyMembershipEvent(bad);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'memberSig')?.ok).toBe(false);
  });

  it('改正文 (add→remove) 带原签名 → 两枚签名都失效', async () => {
    const owner = mkMember('od');
    const m = mkMember('md');
    const ev = await makeAddEvent(owner, m);
    const r = await verifyMembershipEvent({ ...ev, op: 'remove' });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'adminSig')?.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'memberSig')?.ok).toBe(false);
  });

  it('改 orbitdbId (换写身份) 带原签名 → 签名失效', async () => {
    const owner = mkMember('oe');
    const m = mkMember('me');
    const ev = await makeAddEvent(owner, m);
    const swapped = { ...ev, member: { ...ev.member, orbitdbId: '03' + crypto.randomBytes(32).toString('hex') } };
    const r = await verifyMembershipEvent(swapped);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'adminSig')?.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'memberSig')?.ok).toBe(false);
  });

  it('group-match: 事件指向别的群 → 不通过', async () => {
    const owner = mkMember('of');
    const m = mkMember('mf');
    const ev = await makeAddEvent(owner, m);
    const r = await verifyMembershipEvent(ev, { group: '/orbitdb/zdpuOther' });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'group-match')?.ok).toBe(false);
  });

  it('缺一枚签名 → 组装时直接拒', async () => {
    const owner = mkMember('og');
    const m = mkMember('mg');
    const stmt = buildMembershipStatement({ group: GROUP, op: 'add', member: m.ref, by: { did: owner.ref.did, publicKeyHex: owner.ref.publicKeyHex }, ts: 7 });
    const memberSig = await signAsMember(stmt, m.priv);
    expect(() => assembleMembershipEvent(stmt, { memberSig, adminSig: '' })).toThrow(/adminSig/);
    const adminSig = await signAsAdmin(stmt, owner.priv);
    expect(() => assembleMembershipEvent(stmt, { memberSig: '', adminSig })).toThrow(/memberSig/);
  });

  it('验签对象是**剥掉签名后的正文** (拿整条事件去验会永远验不过 —— 这个 bug 真犯过)', async () => {
    const owner = mkMember('og2');
    const m = mkMember('mg2');
    const ev = await makeAddEvent(owner, m);
    // 正文 = 事件去掉两枚签名, 逐字节等于当初签的那份
    const stmt = buildMembershipStatement({ group: GROUP, op: 'add', member: m.ref, by: { did: owner.ref.did, publicKeyHex: owner.ref.publicKeyHex }, ts: 1000 });
    expect(membershipSigningPayload(statementOfEvent(ev))).toBe(membershipSigningPayload(stmt));
    // 签名不在被签字节串里
    expect(membershipSigningPayload(statementOfEvent(ev))).not.toContain(ev.adminSig);
    expect(membershipSigningPayload(statementOfEvent(ev))).not.toContain(ev.memberSig);
  });

  it('签名对象是 canonicalize(statement) — 键序无关, 逐字节稳定', () => {
    const stmt: MembershipStatement = {
      protocol: GROUP_MEMBERSHIP_PROTOCOL,
      group: GROUP,
      op: 'add',
      member: { did: 'did:key:zABC', publicKeyHex: 'f'.repeat(64), orbitdbId: '02' + 'a'.repeat(64) },
      by: { did: 'did:key:zDEF', publicKeyHex: 'e'.repeat(64) },
      ts: 42,
    };
    const p1 = membershipSigningPayload(stmt);
    const p2 = membershipSigningPayload(JSON.parse(JSON.stringify(stmt)) as MembershipStatement);
    expect(p1).toBe(p2);
    expect(p1.startsWith('{')).toBe(true);
    expect(p1).not.toContain(' '); // canonicalize 无空格
  });

  // ---------- 白名单派生 ----------

  it('派生: 群主恒在, add 进白名单, 非群主发起的变更被拒', async () => {
    const owner = mkMember('oh');
    const m1 = mkMember('h1');
    const attacker = mkMember('ha');
    const good = await makeAddEvent(owner, m1, 1000);
    // 攻击者 (不是群主) 自签 add
    const badStmt = buildMembershipStatement({ group: GROUP, op: 'add', member: attacker.ref, by: { did: attacker.ref.did, publicKeyHex: attacker.ref.publicKeyHex }, ts: 2000 });
    const bad = await createMembershipEvent({ statement: badStmt, memberPrivateKeyHex: attacker.priv, adminPrivateKeyHex: attacker.priv });

    const r = await applyMembershipEvents({ owner: owner.ref, events: [good, bad], group: GROUP });
    expect(r.write).toContain(owner.ref.orbitdbId);
    expect(r.write).toContain(m1.ref.orbitdbId);
    expect(r.write).not.toContain(attacker.ref.orbitdbId);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(/UNAUTHORIZED_ISSUER/);
  });

  it('派生: remove 生效; 群主不可被移除; add→remove 抵消', async () => {
    const owner = mkMember('oi');
    const m = mkMember('mi');
    const add = await makeAddEvent(owner, m, 1000);
    const rmvStmt = buildMembershipStatement({ group: GROUP, op: 'remove', member: m.ref, by: { did: owner.ref.did, publicKeyHex: owner.ref.publicKeyHex }, ts: 2000 });
    const rmv = await createMembershipEvent({ statement: rmvStmt, memberPrivateKeyHex: m.priv, adminPrivateKeyHex: owner.priv });

    const afterAdd = await applyMembershipEvents({ owner: owner.ref, events: [add], group: GROUP });
    expect(afterAdd.write).toContain(m.ref.orbitdbId);

    const afterRemove = await applyMembershipEvents({ owner: owner.ref, events: [add, rmv], group: GROUP });
    expect(afterRemove.write).not.toContain(m.ref.orbitdbId);
    expect(afterRemove.write).toEqual([owner.ref.orbitdbId]);

    // 移除群主 → 拒
    const killOwner = buildMembershipStatement({ group: GROUP, op: 'remove', member: owner.ref, by: { did: owner.ref.did, publicKeyHex: owner.ref.publicKeyHex }, ts: 3000 });
    const killEv = await createMembershipEvent({ statement: killOwner, memberPrivateKeyHex: owner.priv, adminPrivateKeyHex: owner.priv });
    const r2 = await applyMembershipEvents({ owner: owner.ref, events: [killEv], group: GROUP });
    expect(r2.rejected[0].reason).toMatch(/CANNOT_REMOVE_OWNER/);
    expect(r2.write).toEqual([owner.ref.orbitdbId]);
  });

  it('派生: 事件顺序无关 (按 ts 排) + 结果稳定排序 (同一集合 → 同一白名单)', async () => {
    const owner = mkMember('oj');
    const m1 = mkMember('j1');
    const m2 = mkMember('j2');
    const e1 = await makeAddEvent(owner, m1, 1000);
    const e2 = await makeAddEvent(owner, m2, 3000);
    const rev = await applyMembershipEvents({ owner: owner.ref, events: [e2, e1], group: GROUP });
    const fwd = await applyMembershipEvents({ owner: owner.ref, events: [e1, e2], group: GROUP });
    expect(rev.write).toEqual(fwd.write);
    expect(rev.write).toEqual(normalizeWriteList(rev.write)); // 已排序
  });

  it('派生: 验签不过的事件**不改**白名单 (坏事件不进名单)', async () => {
    const owner = mkMember('ok');
    const m = mkMember('mk');
    const ev = await makeAddEvent(owner, m);
    const tampered: MembershipEvent = { ...ev, memberSig: ev.memberSig.slice(0, -4) + 'ZZZZ' };
    const r = await applyMembershipEvents({ owner: owner.ref, events: [tampered], group: GROUP });
    expect(r.write).toEqual([owner.ref.orbitdbId]);
    expect(r.rejected[0].reason).toMatch(/VERIFY_FAILED/);
  });

  it('条目形状: 带 kind 标记, ts = 事件 ts', async () => {
    const owner = mkMember('ol');
    const m = mkMember('ml');
    const ev = await makeAddEvent(owner, m, 12345);
    const entry = membershipEntryOf(ev);
    expect(entry.kind).toBe(GROUP_MEMBERSHIP_KIND);
    expect(entry.ts).toBe(12345);
    expect((entry as any).text).toBeUndefined(); // 不能长得像聊天消息
  });

  // ---------- ACL 选项 / 判定 / 重建代价 ----------

  it('writeListAllows 镜像 canAppend: 名单里 / 含 * 才放行', () => {
    expect(writeListAllows('02aa', ['02bb', '02aa'])).toBe(true);
    expect(writeListAllows('02cc', ['02bb', '02aa'])).toBe(false);
    expect(writeListAllows('02cc', ['*'])).toBe(true);
    expect(writeListAllows('02cc', [])).toBe(false);
  });

  it('groupAccessOptions: 空名单要拒 (空名单会被 accessControllerOption 丢掉 → 落回默认)', () => {
    expect(() => groupAccessOptions([])).toThrow(/白名单不能为空/);
    const o = groupAccessOptions(['02' + 'b'.repeat(64), '02' + 'a'.repeat(64)]);
    expect(o.accessController.write).toEqual(['02' + 'a'.repeat(64), '02' + 'b'.repeat(64)]);
  });

  it('aclChangePlan: 如实标 mustRebuild + 列出代价; 名单没变则 changed=false', () => {
    const before = ['02' + 'a'.repeat(64)];
    const after = ['02' + 'a'.repeat(64), '02' + 'b'.repeat(64)];
    const p = aclChangePlan({ before, after, messageCount: 7 });
    expect(p.mustRebuild).toBe(true);
    expect(p.strategy).toBe('rebuild');
    expect(p.changed).toBe(true);
    expect(p.costs.length).toBeGreaterThanOrEqual(4);
    expect(p.costs.join(' ')).toMatch(/新地址/);
    const same = aclChangePlan({ before, after: before });
    expect(same.changed).toBe(false);
  });

  it('ACL_INPLACE_UPDATE: IPFS 型就地更新 = false (源码事实), orbitdb 型只算 partial', () => {
    expect(ACL_INPLACE_UPDATE.ipfsType.inPlace).toBe(false);
    expect(ACL_INPLACE_UPDATE.orbitdbType.inPlace).toBe('partial');
  });
});
