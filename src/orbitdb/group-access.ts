/**
 * group-access.ts — 群写入权限的 **DID 门控** (2026-10-01, P1)
 * ==========================================================================
 * 目标: 把群 (OrbitDB events store) 的写入权限从 `write:['*']` 收紧成"DID 白名单":
 *   建群者 + **显式加入**的成员能写; 其余人**写不进 log**; 成员变更本身是一条
 *   **可离线验签**的群事件 (成员自签 + 管理员签 ⇒ 不是某个中心节点单方面说了算)。
 *
 * ── 先读源码再动手 (@orbitdb/core 4.0.0, node_modules 里就是权威) ───────────
 *
 *  ① 真正的写闸门 = store manifest 里的 access controller (AC)。
 *     `IPFSAccessController.canAppend` 逐条判:
 *       `write.includes(entry 写者的 identity.id) || write.includes('*')`
 *       —— `access-controllers/ipfs.js:78-90`。
 *     ⚠️ 比较的是 **OrbitDB 身份 id**, 不是 DID。而 OrbitDB 身份 id =
 *       keystore 里该身份的**压缩 secp256k1 公钥 hex** (66 位, 02/03 开头):
 *       `key-store.js:213 generateKeyPair('secp256k1')` +
 *       `identities/providers/publickey.js:55 base16(publicKey.raw)`。
 *       **不是 Ed25519** ⇒ DID 与写身份是**两把钥匙**, 必须显式绑定。
 *       本模块的成员事件就是那张绑定凭证 (`member.did ↔ member.orbitdbId`)。
 *
 *  ② 白名单能否在**既有 store** 上增量更新? —— 对 IPFS 型 AC: **不能**。
 *     `write` 被打进一个 dag-cbor 的 ACL manifest, 该 ACL 的 **CID** 写进 store
 *     manifest 的 `accessController` 字段, 而 store manifest 的 **CID 就是 store 地址**:
 *       `access-controllers/ipfs.js:16-25, 62-69`  →  `manifest-store.js:38-56`
 *       →  `orbitdb.js:125-134,140-142`。
 *     改白名单 ⇒ 新 ACL 块 ⇒ 新 manifest ⇒ **新地址**。
 *     整个包对 IPFS 型 AC **没有任何"就地改 AC"的 API**
 *     (`ipfs.js` 只返回 `{type, address, write, canAppend}`, 没有 grant/revoke/mutate)。
 *     ⇒ **白名单变更 = 重建 store (换地址)**; 老地址的写集合永远不变 (历史不可追认)。
 *        代价见 `aclChangePlan()`。
 *
 *  ③ 4.0.0 另有一个 `OrbitDBAccessController` (type `'orbitdb'`), 它把白名单搬进一个
 *     **独立的 keyvalue db** 并提供 `grant`/`revoke` (`access-controllers/orbitdb.js:152-174`),
 *     所以**那一层是**可增量的。但:
 *       · 那个 kv db 自己的**根写名单仍冻结**在它的 IPFS 型 manifest 里 —— 只有根名单里的人
 *         能 grant/revoke (`OrbitDBAccessController({write})` 内部就是这么建的, 见 orbitdb.js:40);
 *       · 增量要生效, 必须先把这个 **AC kv db 复制到对端** (等于多同步一个 store);
 *       · 2026-10-01 本机真两节点实测 (见报告): 对一个**开 store 前就已 grant** 的新节点,
 *         动态白名单能拿到; 但对一个**已经开着 store** 的节点, 180s 内**没看到** live grant
 *         传播到位。⇒ 不当默认, 只作为可选增量通道记录在此, 不冒充"已实现"。
 *     ⇒ 默认策略 = ① 的静态白名单 + ②的重建; 语义确定, 不留"白名单到底传没传过去"的悬念。
 *
 * ── 诚实边界 ──────────────────────────────────────────────────────────────
 *   · 本模块**只做**身份/白名单/成员事件的构造与验证 + ACL 选项生成;
 *     它不自己开 store、不自己起节点 (由 gateway-group / 验收门调)。
 *   · `verifyMembershipEvent` 是**真** Ed25519 验签 (`ed25519Verify`), 不是摘要比对。
 *   · 白名单里的东西是 **OrbitDB 身份 id**, 不是 DID 字符串 —— 别把 DID 塞进 `write`,
 *     `canAppend` 永远匹配不上 (这会静默变成"谁都写不了")。
 */

import { canonicalize, ed25519Sign, ed25519Verify } from '../agents/x402/paid-info-protocol.js';
import { didFromEd25519PublicKey } from '../agents/identity/address-binding.js';

// ─────────────────────────────────────────────────────────── 常量 (冻结)

/** 成员事件协议名 (冻结; 签名对象里的 `protocol`) */
export const GROUP_MEMBERSHIP_PROTOCOL = 'bolloon-group-membership/1';

/** 落在群 store 里的条目种类标记 (带这个 kind 的条目**不是**聊天消息) */
export const GROUP_MEMBERSHIP_KIND = 'bolloon.group.membership';

/** OrbitDB 写身份 id 的形状: 压缩 secp256k1 公钥 hex = 33B = 66 位, 02/03 开头 */
export const ORBITDB_IDENTITY_ID_RE = /^0[23][0-9a-f]{64}$/;

/** Ed25519 公钥 (raw 32B) hex 形状 */
export const ED25519_PUBKEY_HEX_RE = /^[0-9a-f]{64}$/;

/** `did:key:z…` 形状 (与 address-binding 的 BINDING_DID_RE 同构) */
export const DID_KEY_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,}$/;

// ─────────────────────────────────────────────────────────── 类型

/** 一个成员的两把钥匙: DID (Ed25519, 人/agent 可见身份) + OrbitDB 写身份 (secp256k1) */
export interface MemberRef {
  /** `did:key:z…` — 由 publicKeyHex 派生, 必须一致 */
  did: string;
  /** Ed25519 raw 32B 公钥 hex (64 位小写) */
  publicKeyHex: string;
  /** OrbitDB 写身份 id (= `orbitdb.identity.id`, 66 位压缩 secp256k1 公钥 hex) */
  orbitdbId: string;
}

/** 成员变更声明的正文 (签名对象就是它; 不含签名) */
export interface MembershipStatement {
  protocol: string;
  /** 目标群 store 地址 (`/orbitdb/…`) —— 事件只对这一个群有效 */
  group: string;
  op: 'add' | 'remove';
  member: MemberRef;
  /** 发起人 (v1: 只允许群主) —— 带上公钥, 验证方不需要 DID 解析器 */
  by: { did: string; publicKeyHex: string };
  ts: number;
}

/** 一条可离线验签的成员变更事件 */
export interface MembershipEvent extends MembershipStatement {
  /** 成员本人对自己 (did, orbitdbId) 的 Ed25519 签名 (base64) —— **成员同意** */
  memberSig: string;
  /** 发起人的 Ed25519 签名 (base64) —— **管理决定** */
  adminSig: string;
}

/** 落在群 store 里的成员事件条目 */
export interface MembershipEntry {
  kind: typeof GROUP_MEMBERSHIP_KIND;
  event: MembershipEvent;
  ts: number;
}

export interface MembershipCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface MembershipVerifyResult {
  ok: boolean;
  checks: MembershipCheck[];
}

export interface MembershipApplyResult {
  /** 派生出的 ACL 写名单 (OrbitDB 身份 id; 已去重 + 稳定排序) */
  write: string[];
  /** 派生出的成员 (不含群主) */
  members: MemberRef[];
  accepted: MembershipEvent[];
  rejected: Array<{ event: unknown; reason: string }>;
}

// ─────────────────────────────────────────────────────────── 形状校验

function assertMemberRef(m: unknown, where: string): asserts m is MemberRef {
  const r = m as MemberRef;
  if (!r || typeof r !== 'object') throw new Error(`${where}: 成员对象缺失`);
  if (!DID_KEY_RE.test(String(r.did || ''))) {
    throw new Error(`${where}: did 形状非法 (要 did:key:z…), 实得 ${String(r.did || '').slice(0, 40)}`);
  }
  if (!ED25519_PUBKEY_HEX_RE.test(String(r.publicKeyHex || ''))) {
    throw new Error(`${where}: publicKeyHex 必须是 64 位小写 hex`);
  }
  if (!ORBITDB_IDENTITY_ID_RE.test(String(r.orbitdbId || ''))) {
    throw new Error(
      `${where}: orbitdbId 形状非法 (要 66 位压缩 secp256k1 公钥 hex, 02/03 开头), 实得 ${String(r.orbitdbId || '').slice(0, 24)}`
    );
  }
  const derived = didFromEd25519PublicKey(r.publicKeyHex);
  if (derived !== r.did) {
    throw new Error(`${where}: did 与 publicKeyHex 不是同一把钥匙 (期望 ${derived.slice(0, 24)}…, 实得 ${r.did.slice(0, 24)}…)`);
  }
}

/**
 * 造一条成员变更声明 (纯函数, 不签名)。
 * 校验: op/ts/group 形状 + 成员与发起人的 (did ↔ 公钥) 一致 + orbitdbId 形状。
 */
export function buildMembershipStatement(input: {
  group: string;
  op: 'add' | 'remove';
  member: MemberRef;
  by: { did: string; publicKeyHex: string };
  ts?: number;
}): MembershipStatement {
  const group = String(input.group || '').trim();
  if (!group.startsWith('/orbitdb/')) throw new Error(`group 必须是 /orbitdb/… 地址, 实得 ${group.slice(0, 40)}`);
  if (input.op !== 'add' && input.op !== 'remove') throw new Error(`op 必须是 add|remove, 实得 ${String(input.op)}`);
  assertMemberRef(input.member, 'member');
  if (!input.by || typeof input.by !== 'object') throw new Error('by 缺失');
  if (!DID_KEY_RE.test(String(input.by.did || ''))) throw new Error('by.did 形状非法 (要 did:key:z…)');
  if (!ED25519_PUBKEY_HEX_RE.test(String(input.by.publicKeyHex || ''))) throw new Error('by.publicKeyHex 必须是 64 位小写 hex');
  const derivedBy = didFromEd25519PublicKey(input.by.publicKeyHex);
  if (derivedBy !== input.by.did) throw new Error('by.did 与 by.publicKeyHex 不是同一把钥匙');
  const ts = input.ts ?? Date.now();
  if (!Number.isInteger(ts) || ts <= 0) throw new Error(`ts 必须是正整数毫秒, 实得 ${String(input.ts)}`);
  return {
    protocol: GROUP_MEMBERSHIP_PROTOCOL,
    group,
    op: input.op,
    member: { did: input.member.did, publicKeyHex: input.member.publicKeyHex, orbitdbId: input.member.orbitdbId },
    by: { did: input.by.did, publicKeyHex: input.by.publicKeyHex },
    ts,
  };
}

/** 签名对象 = `canonicalize(statement)` 的字节串 (键递归排序, 无空格) */
export function membershipSigningPayload(stmt: MembershipStatement): string {
  return canonicalize(stmt);
}

/**
 * 从事件里**剥出正文** (丢掉 memberSig/adminSig) —— 验签必须对正文, 不能对整条事件:
 * 签名在事件里, 拿整条事件去 canonicalize 会把签名本身搅进被签字节串, 自己签自己, 永远验不过。
 */
export function statementOfEvent(ev: MembershipEvent): MembershipStatement {
  return {
    protocol: ev.protocol,
    group: ev.group,
    op: ev.op,
    member: ev.member,
    by: ev.by,
    ts: ev.ts,
  };
}

/** 成员侧签名 (证明"我认领这个 orbitdbId") */
export async function signAsMember(stmt: MembershipStatement, memberPrivateKeyHex: string): Promise<string> {
  const seed = Buffer.from(String(memberPrivateKeyHex || ''), 'hex');
  if (seed.length !== 32) throw new Error(`成员私钥必须是 32 字节 hex (Ed25519 种子), 实得 ${seed.length}B`);
  return ed25519Sign(seed, membershipSigningPayload(stmt));
}

/** 管理侧签名 (证明"我同意这次成员变更") */
export async function signAsAdmin(stmt: MembershipStatement, adminPrivateKeyHex: string): Promise<string> {
  const seed = Buffer.from(String(adminPrivateKeyHex || ''), 'hex');
  if (seed.length !== 32) throw new Error(`发起人私钥必须是 32 字节 hex (Ed25519 种子), 实得 ${seed.length}B`);
  return ed25519Sign(seed, membershipSigningPayload(stmt));
}

/** 把两枚签名与正文组装成事件 (只校形状, 不验签; 验签用 verifyMembershipEvent) */
export function assembleMembershipEvent(
  stmt: MembershipStatement,
  sigs: { memberSig: string; adminSig: string }
): MembershipEvent {
  const memberSig = String(sigs.memberSig || '');
  const adminSig = String(sigs.adminSig || '');
  if (!memberSig) throw new Error('缺 memberSig (成员必须自己签)');
  if (!adminSig) throw new Error('缺 adminSig (发起人必须自己签)');
  return { ...stmt, memberSig, adminSig };
}

/** 一次性造事件 (成员 + 管理员各自私钥都在手上时用; 门/测试用) */
export async function createMembershipEvent(input: {
  statement: MembershipStatement;
  memberPrivateKeyHex: string;
  adminPrivateKeyHex: string;
}): Promise<MembershipEvent> {
  const memberSig = await signAsMember(input.statement, input.memberPrivateKeyHex);
  const adminSig = await signAsAdmin(input.statement, input.adminPrivateKeyHex);
  return assembleMembershipEvent(input.statement, { memberSig, adminSig });
}

/** 事件 → 落库条目 */
export function membershipEntryOf(ev: MembershipEvent): MembershipEntry {
  return { kind: GROUP_MEMBERSHIP_KIND, event: ev, ts: ev.ts };
}

// ─────────────────────────────────────────────────────────── 验签

function fail(checks: MembershipCheck[], name: string, detail: string): boolean {
  checks.push({ name, ok: false, detail });
  return false;
}

/**
 * 验一条成员事件 —— **真 Ed25519 验签**, 双侧都验 (成员 + 管理员), 少一侧 = 拒。
 *
 * 检查项 (任何一项不过 → `ok:false`, 但 `checks` 全量列出, 便于定位):
 *   ① 协议名 / op / ts / group 形状
 *   ② member.did 由 member.publicKeyHex 派生、by.did 由 by.publicKeyHex 派生 (两把钥匙一致)
 *   ③ member.orbitdbId 形状 (必须真能被当成写身份)
 *   ④ adminSig 对 `canonicalize(statement)` 验签通过 (by.publicKeyHex)
 *   ⑤ memberSig 对同一份字节串验签通过 (member.publicKeyHex)
 *   ⑥ 若给了 opts.group → 事件必须指向同一个群
 */
export async function verifyMembershipEvent(
  ev: MembershipEvent,
  opts: { group?: string } = {}
): Promise<MembershipVerifyResult> {
  const checks: MembershipCheck[] = [];
  const e = ev as MembershipEvent;

  if (!e || typeof e !== 'object') return { ok: false, checks: [{ name: 'shape', ok: false, detail: '事件不是对象' }] };

  checks.push({
    name: 'protocol',
    ok: e.protocol === GROUP_MEMBERSHIP_PROTOCOL,
    detail: `protocol=${String(e.protocol)} (要 ${GROUP_MEMBERSHIP_PROTOCOL})`,
  });
  checks.push({ name: 'op', ok: e.op === 'add' || e.op === 'remove', detail: `op=${String(e.op)}` });
  checks.push({
    name: 'group',
    ok: typeof e.group === 'string' && e.group.startsWith('/orbitdb/'),
    detail: `group=${String(e.group).slice(0, 48)}`,
  });
  checks.push({
    name: 'ts',
    ok: Number.isInteger(e.ts) && e.ts > 0,
    detail: `ts=${String(e.ts)}`,
  });

  const memberOk = (() => {
    try { assertMemberRef(e.member, 'member'); return true; }
    catch (err) { checks.push({ name: 'member-binding', ok: false, detail: String((err as Error).message) }); return false; }
  })();
  if (memberOk) checks.push({ name: 'member-binding', ok: true, detail: 'member.did ↔ member.publicKeyHex 同钥匙 (did:key 由公钥派生)' });

  let byOk = false;
  try {
    if (!e.by || !DID_KEY_RE.test(String(e.by.did || '')) || !ED25519_PUBKEY_HEX_RE.test(String(e.by.publicKeyHex || ''))) {
      fail(checks, 'by-binding', `by 形状非法 (did=${String(e.by?.did || '').slice(0, 20)})`);
    } else if (didFromEd25519PublicKey(e.by.publicKeyHex) !== e.by.did) {
      fail(checks, 'by-binding', 'by.did 与 by.publicKeyHex 不是同一把钥匙');
    } else {
      byOk = true;
      checks.push({ name: 'by-binding', ok: true, detail: 'by.did ↔ by.publicKeyHex 同钥匙' });
    }
  } catch (err) {
    fail(checks, 'by-binding', String((err as Error).message));
  }

  // ④⑤ 验签 (把不通过的项也列出来; 形如 sig 缺失直接判否)
  let adminSigOk = false;
  let memberSigOk = false;
  try {
    const payload = membershipSigningPayload(statementOfEvent(e));
    adminSigOk = byOk && typeof e.adminSig === 'string' && e.adminSig.length > 0
      ? await ed25519Verify(e.by.publicKeyHex, payload, e.adminSig)
      : false;
    checks.push({
      name: 'adminSig',
      ok: adminSigOk,
      detail: adminSigOk ? '发起人 Ed25519 验签通过' : '发起人签名验签**不通过** (或 by 公钥不可用)',
    });
    memberSigOk = memberOk && typeof e.memberSig === 'string' && e.memberSig.length > 0
      ? await ed25519Verify(e.member.publicKeyHex, payload, e.memberSig)
      : false;
    checks.push({
      name: 'memberSig',
      ok: memberSigOk,
      detail: memberSigOk ? '成员 Ed25519 验签通过 (成员同意)' : '成员签名验签**不通过** (成员未同意 / 被改过)',
    });
  } catch (err) {
    fail(checks, 'sig-verify', String((err as Error).message));
  }

  if (opts.group !== undefined) {
    checks.push({
      name: 'group-match',
      ok: e.group === opts.group,
      detail: `事件群=${String(e.group).slice(0, 40)} 期望=${String(opts.group).slice(0, 40)}`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// ─────────────────────────────────────────────────────────── 白名单派生

/** 镜像 `access-controllers/ipfs.js:85` 的判定 (`write.includes(id) || write.includes('*')`) */
export function writeListAllows(orbitdbId: string, write: string[]): boolean {
  if (!Array.isArray(write)) return false;
  return write.includes('*') || write.includes(String(orbitdbId));
}

/** 去重 + 稳定排序 —— 同一成员集合在任何节点派生出的白名单**逐字节一致** (ACL CID 才会一致) */
export function normalizeWriteList(ids: string[]): string[] {
  const uniq = Array.from(new Set(ids.map((x) => String(x).trim()).filter(Boolean)));
  return uniq.sort();
}
const normalizeWrite = normalizeWriteList;

/**
 * 从群主 + 成员事件**派生** ACL 写名单。
 *
 * 规则 (v1, 刻意简单因此可核验):
 *   · 群主恒在名单里, 且**不可被 remove**;
 *   · 只有 `by.did === owner.did` 的 add/remove 被接受 (v1 只有群主能改成员);
 *   · 事件必须先**验签通过** (`verifyMembershipEvent`) 才参与派生 —— 没验过的事件不改白名单;
 *   · 事件按 `ts` 升序应用 (同 ts 按输入顺序), `add` 去重、`remove` 移除 (除群主)。
 *   · **不受 ts 单调性以外的时序影响**: 同一批事件 → 同一名单 → 同一 ACL。
 */
export async function applyMembershipEvents(input: {
  owner: MemberRef;
  events: MembershipEvent[];
  group?: string;
}): Promise<MembershipApplyResult> {
  try { assertMemberRef(input.owner, 'owner'); } catch (err) { throw new Error(`群主身份非法: ${(err as Error).message}`); }

  const order = input.events.map((e, i) => ({ e, i }))
    .sort((a, b) => (Number(a.e?.ts ?? 0) - Number(b.e?.ts ?? 0)) || (a.i - b.i));

  const accepted: MembershipEvent[] = [];
  const rejected: Array<{ event: unknown; reason: string }> = [];
  const members = new Map<string, MemberRef>();

  for (const { e } of order) {
    const v = await verifyMembershipEvent(e, input.group !== undefined ? { group: input.group } : {});
    if (!v.ok) {
      rejected.push({ event: e, reason: 'VERIFY_FAILED: ' + v.checks.filter((c) => !c.ok).map((c) => c.name).join(',') });
      continue;
    }
    if (e.by.did !== input.owner.did) {
      rejected.push({ event: e, reason: `UNAUTHORIZED_ISSUER: ${e.by.did.slice(0, 24)}… 不是群主` });
      continue;
    }
    if (e.op === 'add') {
      if (e.member.orbitdbId === input.owner.orbitdbId) {
        rejected.push({ event: e, reason: 'OWNER_ALREADY_MEMBER' });
        continue;
      }
      members.set(e.member.orbitdbId, {
        did: e.member.did, publicKeyHex: e.member.publicKeyHex, orbitdbId: e.member.orbitdbId,
      });
    } else {
      if (e.member.orbitdbId === input.owner.orbitdbId) {
        rejected.push({ event: e, reason: 'CANNOT_REMOVE_OWNER' });
        continue;
      }
      members.delete(e.member.orbitdbId);
    }
    accepted.push(e);
  }

  const memberRefs = Array.from(members.values()).sort((a, b) => (a.orbitdbId < b.orbitdbId ? -1 : a.orbitdbId > b.orbitdbId ? 1 : 0));
  return {
    write: normalizeWrite([input.owner.orbitdbId, ...memberRefs.map((m) => m.orbitdbId)]),
    members: memberRefs,
    accepted,
    rejected,
  };
}

// ─────────────────────────────────────────────────────────── ACL 选项 / 变更代价

/**
 * 把白名单接成 `CIDDatabase.openStore` 认的选项。
 * `cid-database.accessControllerOption()` 会把它翻成 OrbitDB v4 真认的大写
 * `AccessController: IPFSAccessController({ write })` (小写会被静默丢弃 —— 2026-09-24 的坑)。
 */
export function groupAccessOptions(write: string[]): { accessController: { write: string[] } } {
  if (!Array.isArray(write) || write.length === 0) throw new Error('白名单不能为空 (空名单会被 accessControllerOption 丢掉 → 落回默认策略)');
  return { accessController: { write: normalizeWrite(write) } };
}

/** IPFS 型 AC 的"就地更新"能力 —— 源码事实, 不是推测 */
export const ACL_INPLACE_UPDATE = {
  ipfsType: {
    inPlace: false as const,
    why: 'write 在内容寻址的 ACL manifest 里, ACL CID → store manifest → store 地址; 改白名单必然换地址; 包里没有 AC 的 mutate/grant API',
  },
  orbitdbType: {
    inPlace: 'partial' as const,
    why: 'grant/revoke 写一个独立的 AC keyvalue db (可复制); 但那 kv db 自己的根写名单仍冻结在它的 IPFS manifest 里 —— 只有根名单里的人能改; 且增量生效依赖该 kv db 复制到对端',
  },
} as const;

export interface AclChangePlan {
  mustRebuild: true;
  strategy: 'rebuild';
  why: string;
  costs: string[];
  before: string[];
  after: string[];
  changed: boolean;
}

/**
 * 成员变更的执行计划 (诚实版): IPFS 型 AC 下**只能重建**。
 * 把代价逐条写出来, 免得下游把"换地址"当免费操作。
 */
export function aclChangePlan(input: { before: string[]; after: string[]; messageCount?: number }): AclChangePlan {
  const before = normalizeWrite(input.before);
  const after = normalizeWrite(input.after);
  const changed = before.join(',') !== after.join(',');
  return {
    mustRebuild: true,
    strategy: 'rebuild',
    why: ACL_INPLACE_UPDATE.ipfsType.why,
    changed,
    before,
    after,
    costs: [
      '新建 store ⇒ **新地址 (新 manifest CID)**: 老成员手里的群链接/群地址全部作废, 必须重新分发',
      '老地址的写名单**不可追认**: 未在重建时列进去的人, 连老地址都写不了 (老地址本身已经是收紧后的名单)',
      '历史消息**不会自动搬过去**: 新 store 只有新地址的 oplog; 要保留历史必须显式回放 (逐条 add) 或让成员两头都读',
      `本机已落盘的旧 store 不会删除 (占用不回收); 消息条数 ${Number(input.messageCount ?? 0)} 条需要回放才不丢`,
      '重建期间**两边都能写**的窗口不存在: 切换只认新地址, 老地址冻结 (没有双写机制, 别假装有)',
    ],
  };
}
