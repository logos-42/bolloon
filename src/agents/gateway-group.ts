/**
 * gateway-group.ts — Agent Gateway P2P 群组 (2026-08-14)
 *
 * 群组 = OrbitDB events store, 全成员通过 OrbitDB pubsub 复制实时同步.
 * 链接: orbitdb://<addr>?type=group&name=<群名>.
 *
 * 符合用户习惯: 群组 = 微信式群聊 — 加入链接即进群, 发消息全网同步.
 * 持久化: ~/.bolloon/gateway-groups.json (重启后仍是群成员, 自动重开 store).
 *
 * 2026-09-24 跨进程可重开:
 *   · 群消息 (OrbitDB events store 的 oplog 条目 + manifest) 现在真落盘 ——
 *     `createBolloonIpfs` 用 FsBlockstore/FsDatastore 写 ~/.bolloon/orbitdb/ipfs/{blocks,datastore},
 *     所以"建群的那个进程退出后, 新进程用群链接重开还能读到既有消息"。
 *     (修复前: 区块只在内存, 新进程一开就报 "No block brokers capable of retrieving blocks")
 *   · 读不到必须报读不到: `groupMessages` 在 store 打不开时**抛 GroupStoreUnreachableError**,
 *     不再返回 `[]`。把"读不到"显示成"群里没有消息"是骗人, 本条不可回退。
 *
 * 2026-10-01 (P1) DID 门控:
 *   · `createGroup(name, { gate: { owner, members?, membershipEvents? } })` 建的是**门控群**:
 *     写入白名单 = 群主 OrbitDB 写身份 + 显式成员, 非名单成员 add 会被拒。
 *   · 不给 `gate` → 行为**一字不变** (write:['*']); 默认翻成门控需要先迁移全部既有调用点。
 *   · 成员变更 = `MembershipEvent` (成员自签 + 群主签, 双侧 Ed25519 验签), 读写入口
 *     `recordMembershipEvent` / `groupMembershipEvents` / `groupWriteList`。
 *   · **白名单不能就地改** (IPFS 型 AC 的白名单在内容寻址的 ACL 块里, 改它 = 换 store 地址),
 *     所以"改成员"= 重建 store; 代价清单见 `group-access.ts` 的 `aclChangePlan()`。
 */

import * as os from 'os';
import * as path from 'path';
import { getCIDDatabase, type CIDDatabase, type OrbitDBStore } from '../orbitdb/cid-database.js';
// 2026-09-28: 交流语言 (Efficode 是可选项, 不是默认项) —— 只有双方都声明才用
import { decodeFromPeer, encodeForPeer, recordLangDecision, type IncomingResult } from '../efficode/negotiate.js';
import type { AgentLang, OpSymbol } from '../efficode/types.js';
// 2026-10-01 (P1): **DID 门控** —— 群写入白名单从 write:['*'] 收紧成成员白名单。
// 白名单里放的是 **OrbitDB 写身份 id** (66 位压缩 secp256k1 公钥 hex), 不是 DID 字符串
// (canAppend 只比 identity.id; 放 DID 会永远匹配不上 → 谁都写不了)。
// 成员变更 = 一条**双侧 Ed25519 验签**的群事件 (成员自签 + 群主签), 细节见 group-access.ts。
import {
  applyMembershipEvents,
  groupAccessOptions,
  membershipEntryOf,
  normalizeWriteList,
  verifyMembershipEvent,
  GROUP_MEMBERSHIP_KIND,
  type MemberRef,
  type MembershipEntry,
  type MembershipEvent,
} from '../orbitdb/group-access.js';

// ============ 依赖注入 (测试用, 避免单测起真实 OrbitDB 节点) ============

let _dbOverride: CIDDatabase | null = null;
/** 测试用: 注入 fake CIDDatabase */
export function setGroupTestDb(db: CIDDatabase | null): void { _dbOverride = db; }
function getDb(): CIDDatabase { return _dbOverride ?? getCIDDatabase(); }

/** 测试用: 清空 store 缓存 / 订阅 (避免测试间污染) */
export function resetGroupState(): void {
  storeCache.clear();
  onChangeCallbacks.clear();
  openFailures.clear();
}

// ============ 类型 ============

/**
 * 2026-10-02 (leo: 「群里的功能包括 @成员 / 回复某条 / 发图片音频 / 建分支」): 附件。
 * 二进制走**内容寻址** —— 消息里只放 CID (字节在内容寻址层), 读的人按 CID 取。
 * 老读者/老消息没有这个字段, 语义完全不变。
 */
export interface GroupAttachment {
  kind: 'image' | 'audio' | 'file';
  cid: string;
  name?: string;
  bytes?: number;
}

export interface GroupMessage {
  from: string;         // did / agentId
  text: string;
  ts: number;
  /** store 条目自带的 id/hash —— 回复它时用 (老条目拿不到就缺字段, 不假造) */
  id?: string;
  /** @ 了谁 (短显示名/DID 都可以, 只当展示用) */
  mentions?: string[];
  /** 回复哪条 (被回复消息的 `id`) */
  replyTo?: string;
  /** 附件 (图片/音频/文件): 只放 CID, 字节在内容寻址层 */
  attachments?: GroupAttachment[];
  /** 属于哪个分支 (缺字段 = 主线) */
  branch?: string;
  /** 记录种类: 'message'(默认, 缺字段) / 'branch'(建分支的宣告) */
  kind?: string;
  /**
   * 2026-09-28: 本条消息用哪种**交流语言**写的 (`natural` | `efficode`).
   * 缺字段 = 没声明 = 自然语言 (老消息/老节点语义完全不变).
   * 未知字符串一律当"不支持"处理, 绝不当成 efficode 去解。
   */
  lang?: string;
}

export interface GroupInfo {
  id: string;           // 本地 id (短名)
  name: string;         // 群名
  address: string;      // OrbitDB store 地址 /orbitdb/...
  link: string;         // 邀请链接
  createdAt: string;
  lastSyncAt?: string;
  messageCount?: number;
  memberCount?: number;
  /**
   * 2026-10-01: DID 门控信息 (只有走 `gate` 建的群才有; 老群/未门控群是 undefined)。
   * `aclWrite` 是**建群时烧进 manifest 的写白名单** —— 打开既有地址时以 manifest 为准,
   * 这里存的是本机快照, 用于展示/自检, 不用它做权限判定。
   */
  gated?: boolean;
  ownerDid?: string;
  aclWrite?: string[];
}

/**
 * 2026-10-01: 走 DID 门控建群要提供的东西。
 * `membershipEvents` 会**重新验签** —— 验不过就拒绝据此建群 (绝不静默降级成 '*' 或默认名单)。
 */
export interface GroupGateInput {
  /** 群主 (DID + Ed25519 公钥 + OrbitDB 写身份) */
  owner: MemberRef;
  /** 直接点名加入的成员 (与 membershipEvents 的 add 取并集) */
  members?: MemberRef[];
  /** 已签名的成员变更事件; createGroup 会重新验签后才采纳 */
  membershipEvents?: MembershipEvent[];
}

export interface JoinGroupResult {
  ok: boolean;
  group?: GroupInfo;
  already?: boolean;
  error?: string;
  /** 失败码 (打不开 store 时 = 'STORE_UNREACHABLE'); 便于上游给结构化信封 */
  code?: 'STORE_UNREACHABLE';
}

/**
 * 群 store 打不开 (区块不在本机 / 地址不可解析)。
 *
 * 2026-09-24: 以前打不开 → `groupMessages` 返回 `[]`, 于是 CLI 把"整个群读不到"报成
 * "群里本期没有过程痕迹 (群里真没有, 不是读失败)" —— 把"读不到"说成了"没有"。
 * 现在读不到就抛: 上游 (task trail / API) 必须如实报 TRANSPORT_FAILED。
 */
export class GroupStoreUnreachableError extends Error {
  readonly code = 'STORE_UNREACHABLE';
  constructor(readonly groupId: string, readonly address: string, readonly cause?: unknown) {
    const why = String((cause as Error)?.message ?? cause ?? '未知原因').slice(0, 160);
    super(`群组 store 不可达 (${groupId}): ${why}`);
    this.name = 'GroupStoreUnreachableError';
  }
}

/** 打开失败的一句话原因 (给人类输出用; 没有失败记录时返回通用话术) */
function unreachableReason(err: unknown): string {
  const m = String((err as Error)?.message ?? err ?? '').trim();
  return m ? m.slice(0, 160) : '区块不在本机且没有可用的 block broker (跨机同步仍是另一回事, 需 peers)';
}

// ============ 持久化 ============

const groupsFile = (): string => path.join(os.homedir() || '/tmp', '.bolloon', 'gateway-groups.json');

async function loadGroups(): Promise<GroupInfo[]> {
  try {
    const { readFile } = await import('fs/promises');
    const parsed = JSON.parse(await readFile(groupsFile(), 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveGroups(list: GroupInfo[]): Promise<void> {
  try {
    const { mkdir, writeFile } = await import('fs/promises');
    await mkdir(path.dirname(groupsFile()), { recursive: true });
    await writeFile(groupsFile(), JSON.stringify(list, null, 2), 'utf-8');
  } catch { /* 持久化失败静默 */ }
}

// ============ 链接解析 ============

/** 解析群组链接: orbitdb://<addr>?type=group&name=<群名> (type 非 group 返回 null) */
export function parseGroupLink(link: string): { address: string; name?: string } | null {
  const l = String(link || '').trim();
  if (!l.startsWith('orbitdb://')) return null;
  const [base, query] = l.split('?');
  let params: URLSearchParams | null = null;
  try { params = query ? new URLSearchParams(query) : null; } catch { /* 忽略 */ }
  if (params && params.get('type') === 'group') {
    let address = base.slice('orbitdb://'.length);
    if (!address.startsWith('/')) address = `/${address}`;
    return { address, name: params.get('name') || undefined };
  }
  return null;
}

/** 从消息文本检测群组链接 */
export function detectGroupLink(text: string): string | null {
  const t = String(text || '');
  const re = /(orbitdb:\/\/\/?orbitdb\/[^\s)'"<>，。；]*\?[^\s)'"<>，。；]*type=group[^\s)'"<>，。；]*)/;
  const m = re.exec(t);
  return m ? m[1].trim() : null;
}

// ============ store 缓存 (避免重复 open) ============

const storeCache = new Map<string, OrbitDBStore>();
/** 订阅回调注册 (server 层挂 SSE 广播) */
const onChangeCallbacks = new Map<string, Set<(msg: GroupMessage) => void>>();
/** store 打开失败的原始原因 (按 groupId) —— 用来把"打不开"和"没有消息"分开 */
const openFailures = new Map<string, unknown>();

function groupIdOf(address: string): string {
  // /orbitdb/zdpu... → zdpu... (地址后 12 位做短 id)
  const m = /\/orbitdb\/(.{8,})/.exec(address);
  return m ? m[1] : address;
}

/**
 * 打开群组 store (缓存)。
 * 打不开 → 记下原始原因 + 返回 null (不抛: 调用方各自决定用什么话术报)。
 * 2026-09-24: 必须 try/catch —— openStoreByAddress 现在抛 OrbitDBStoreUnreachableError。
 *
 * 2026-10-01 (P1): **不再传 `accessController`**。打开一个**合法已存在地址**时, OrbitDB
 * 从 manifest 里取回 ACL 并覆盖入参 (`@orbitdb/core` src/orbitdb.js:129-131), 所以这里
 * 传 `write:['*']` 是**死代码** —— 之前那行会让人误以为"打开时放开成任何人可写"。
 * 真正的写权限 = 建群时烧进 manifest 的白名单 (DID 门控群 = 成员白名单)。
 * 能不能写由 manifest 决定 + 调用方是否 add/put 决定; 本函数不做权限判定。
 */
async function openGroupStore(address: string): Promise<OrbitDBStore | null> {
  const id = groupIdOf(address);
  if (storeCache.has(id)) return storeCache.get(id)!;
  const db = getDb();
  let store: OrbitDBStore | null = null;
  try {
    store = await db.openStoreByAddress(address, 'events', {});
  } catch (e) {
    openFailures.set(id, e);
    return null;
  }
  if (!store) {
    openFailures.set(id, new Error('openStoreByAddress 返回 null (没拿到 store, 也没给出原因)'));
    return null;
  }
  openFailures.delete(id);
  storeCache.set(id, store);
  // 订阅: 新消息 → 通知回调 (server SSE)
  store.onChange(() => {
    groupMessages(id, 5).then((msgs) => {
      if (msgs.length === 0) return;
      const cb = onChangeCallbacks.get(id);
      if (cb) for (const fn of cb) { try { fn(msgs[msgs.length - 1]); } catch { /* 忽略 */ } }
    }).catch(() => {});
  });
  return store;
}

/** 注册群组消息回调 (返回退订函数) */
export function onGroupMessage(groupId: string, fn: (msg: GroupMessage) => void): () => void {
  if (!onChangeCallbacks.has(groupId)) onChangeCallbacks.set(groupId, new Set());
  onChangeCallbacks.get(groupId)!.add(fn);
  return () => { onChangeCallbacks.get(groupId)?.delete(fn); };
}

// ============ 群组操作 ============

/**
 * 创建群组: 新 events store + 持久化 + 生成邀请链接.
 *
 * 权限三条路 (2026-10-01: 默认已收紧):
 *   · 不给 `opts.gate` 也不给 `opts.acl` → **创建者独占**(默认): 不传 write 列表给
 *     IPFSAccessController ⇒ 落回 OrbitDB 默认策略 (只有创建者能写). 老默认是 `write:['*']`,
 *     已按「默认动作不该是敞开的」翻过来.
 *   · `opts.acl === 'open'` → 显式声明 `write:['*']` (任何人可写, 微信式群聊) —— **必须显式写**,
 *     并且会打一行 warn 留痕; 产品的两个真调用点 (server.ts / routes-mobile-tasks.ts) 都显式声明它.
 *   · 给 `opts.gate` → **DID 门控**: 白名单 = 群主 OrbitDB 写身份 + 显式成员 (+ 已验签
 *     add 事件里的成员). 非名单成员的 `add` 会被 OrbitDB 的 `canAppend` 拒掉
 *     ("Key … is not allowed to write to the log").
 *   成员事件在**重新验签通过后**才写进 store; 有一条验不过 → **不建群** (不静默降级).
 */
/** 群的写入权限声明 (2026-10-01): 默认创建者独占; 'open' 必须显式声明 (任何人可写) */
export type GroupAclMode = 'creator' | 'open';

export async function createGroup(
  name: string,
  opts?: { from?: string; hello?: string; gate?: GroupGateInput; acl?: GroupAclMode }
): Promise<JoinGroupResult> {
  const groupName = String(name || '').trim() || `group-${Date.now().toString(36).slice(-4)}`;
  try {
    const db = getDb();

    // ---- 门控分支: 先派生白名单 (验签不过就直接拒), 再建 store ----
    // null = 不传 write 列表 ⇒ OrbitDB 默认 (创建者独占). 不再默认 ['*'].
    let writeList: string[] | null = null;
    let gateInfo: Pick<GroupInfo, 'gated' | 'ownerDid' | 'aclWrite'> = {};
    let membershipEntries: MembershipEntry[] = [];
    if (opts?.gate) {
      const gate = opts.gate;
      const applied = await applyMembershipEvents({
        owner: gate.owner,
        events: gate.membershipEvents ?? [],
      });
      if (applied.rejected.length > 0) {
        return {
          ok: false,
          error: `拒绝据此建群: ${applied.rejected.length} 条成员事件未通过验签/授权 —— ${applied.rejected[0].reason}`,
        };
      }
      // 白名单 = 群主 ∪ 事件派生成员 ∪ 直接点名成员
      const ids = [
        gate.owner.orbitdbId,
        ...applied.members.map((m) => m.orbitdbId),
        ...(gate.members ?? []).map((m) => m.orbitdbId),
      ];
      writeList = normalizeWriteList(ids);
      gateInfo = { gated: true, ownerDid: gate.owner.did, aclWrite: writeList };
      membershipEntries = applied.accepted.map(membershipEntryOf);
    } else if (opts?.acl === 'open') {
      // 显式声明开放写入 (产品语义: 谁拿到邀请链接都能发言) —— 打一行 warn 留痕
      writeList = ['*'];
      console.warn(`[group] ${groupName}: acl=open ⇒ 任何人可写 (调用方显式声明)`);
    } else {
      console.warn(`[group] ${groupName}: 未声明 acl ⇒ 创建者独占写入 (2026-10-01 起的默认)`);
    }

    const store = await db.openStore(
      `bolloon-gw-group-${groupName}`, 'events',
      // 注意: groupAccessOptions([]) 会抛错 (空名单会被 accessControllerOption 丢掉 ⇒ 落回默认),
      // 所以"创建者独占"这条路只能**不传** AC 选项 ⇒ 传 {}.
      writeList ? groupAccessOptions(writeList) : {},
    );
    const address = store.address;
    const id = groupIdOf(address);
    const link = `orbitdb://${address}?type=group&name=${encodeURIComponent(groupName)}`;
    const info: GroupInfo = {
      id, name: groupName, address, link,
      createdAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      ...gateInfo,
    };
    storeCache.set(id, store);
    // 成员变更事件先落库 (它们是"谁能写"的凭证; 带 kind 字段, 不会被当成聊天消息)
    for (const entry of membershipEntries) await store.add(entry);
    // 欢迎消息 (群主自我介绍)
    const from = opts?.from || gateInfo.ownerDid || 'group-owner';
    await store.add({ from, text: opts?.hello || `📢 群主创建了群「${groupName}」, 分享链接邀请成员加入`, ts: Date.now() });
    const groups = await loadGroups();
    await saveGroups([...groups.filter((g) => g.id !== id), info]);
    return { ok: true, group: info };
  } catch (e: any) {
    return { ok: false, error: `创建群组失败: ${String(e?.message || e).slice(0, 160)}` };
  }
}

/**
 * 通过链接加入群组: 打开 store (可写) + 持久化 + 幂等.
 * 失败静默返回错误, 不影响本地.
 */
export async function joinGroup(link: string): Promise<JoinGroupResult> {
  const parsed = parseGroupLink(link);
  if (!parsed) {
    return { ok: false, error: '不是群组链接 (需要 orbitdb://...?type=group&name=...)' };
  }
  // 幂等: 按地址去重
  const existing = await loadGroups();
  const id = groupIdOf(parsed.address);
  if (existing.some((g) => g.id === id)) {
    return { ok: true, already: true, group: existing.find((g) => g.id === id) };
  }
  const store = await openGroupStore(parsed.address);
  if (!store) {
    return {
      ok: false,
      code: 'STORE_UNREACHABLE',
      error: `群组 store 不可达: ${unreachableReason(openFailures.get(id))}`,
    };
  }
  const name = parsed.name || id.slice(0, 12);
  const info: GroupInfo = {
    id, name, address: parsed.address,
    link: `orbitdb://${parsed.address}?type=group&name=${encodeURIComponent(name)}`,
    createdAt: new Date().toISOString(),
    lastSyncAt: new Date().toISOString(),
  };
  await saveGroups([...existing, info]);
  return { ok: true, group: info };
}

/** 列出已加入的群组 */
export async function listGroups(): Promise<GroupInfo[]> {
  return loadGroups();
}

/**
 * 退群 (2026-09-24): 从本机群列表里摘掉 (撤销"我是成员"这条本地事实)。
 *
 * 只改**本机**记录: 群 store 本身是公共 append-only 的, 别人那边的成员表/消息
 * 不会因为本机退出而改 (本模块没有"踢人/解散"的权限, 也不假装有)。
 * 返回 `removed` = 被摘掉的 groupId (按 id 或群名匹配)。
 *
 * 注意: 底层 OrbitDB store 已在进程内打开的**不会**在这里关 (适配层没暴露 close);
 * 对 `bolloon task group leave` 这种一次性进程无影响, 长驻进程里它活到进程结束。
 */
export async function leaveGroup(idOrName: string): Promise<{ ok: boolean; removed?: string; error?: string }> {
  const raw = String(idOrName || '').trim();
  if (!raw) return { ok: false, error: '缺少 groupId (或群名)' };
  const groups = await loadGroups();
  const hit = groups.find((g) => g.id === raw) || groups.find((g) => g.name === raw) || null;
  if (!hit) return { ok: false, error: `本机没有这个群: ${raw} (既不是已加入群的 groupId, 也不是群名)` };
  storeCache.delete(hit.id);
  openFailures.delete(hit.id);
  await saveGroups(groups.filter((g) => g.id !== hit.id));
  return { ok: true, removed: hit.id };
}

/**
 * 获取群组 store 的最新消息 (ts 升序, 取最后 N 条)。
 *
 * 两个"空"必须分开 (2026-09-24):
 *   · 本机没这个群 (不在群列表里) → 返回 `[]` (上游 resolveGroupRef 已单独拦成 NOT_FOUND)
 *   · 群在列表里但 store 打不开 → **抛 GroupStoreUnreachableError** (读不到 ≠ 没有消息)
 */
export async function groupMessages(groupId: string, limit = 50): Promise<GroupMessage[]> {
  let store: OrbitDBStore | null = storeCache.get(groupId) ?? null;
  if (!store) {
    const groups = await loadGroups();
    const g = groups.find((x) => x.id === groupId);
    if (!g) return [];
    store = await openGroupStore(g.address);
    if (!store) throw new GroupStoreUnreachableError(groupId, g.address, openFailures.get(groupId));
  }
  const all = await store.all();
  const msgs: GroupMessage[] = [];
  for (const entry of all) {
    const v = entry.value as any;
    if (v && typeof v.text === 'string' && typeof v.from === 'string') {
      const m: GroupMessage = { from: v.from, text: v.text, ts: typeof v.ts === 'number' ? v.ts : 0 };
      // 只透传字符串形态的语言声明; 别的形状一律当"没声明"(不让脏值进到解码分派)
      if (typeof v.lang === 'string' && v.lang.trim()) m.lang = v.lang.trim();
      // 2026-10-02: 新字段一律**先验形状再透传** (脏值当没声明, 不做修补)
      const entryId = String((entry as any)?.hash ?? (entry as any)?.id ?? '').trim();
      if (entryId) m.id = entryId;
      if (Array.isArray(v.mentions)) {
        const ms = v.mentions.map((x: unknown) => String(x ?? '').trim()).filter(Boolean);
        if (ms.length) m.mentions = ms;
      }
      if (typeof v.replyTo === 'string' && v.replyTo.trim()) m.replyTo = v.replyTo.trim();
      if (typeof v.branch === 'string' && v.branch.trim()) m.branch = v.branch.trim();
      if (typeof v.kind === 'string' && v.kind.trim()) m.kind = v.kind.trim();
      if (Array.isArray(v.attachments)) {
        const at = v.attachments
          .filter((a: any) => a && typeof a.cid === 'string' && /^(image|audio|file)$/.test(String(a.kind)))
          .map((a: any) => ({
            kind: a.kind as GroupAttachment['kind'],
            cid: String(a.cid).trim(),
            ...(typeof a.name === 'string' && a.name.trim() ? { name: a.name.trim().slice(0, 120) } : {}),
            ...(typeof a.bytes === 'number' && Number.isFinite(a.bytes) ? { bytes: a.bytes } : {}),
          }));
        if (at.length) m.attachments = at;
      }
      msgs.push(m);
    }
  }
  msgs.sort((a, b) => a.ts - b.ts);
  return msgs.slice(-limit);
}

/** 群成员: 从消息里提取 from 去重 */
export async function groupMembers(groupId: string): Promise<string[]> {
  const msgs = await groupMessages(groupId, 500);
  return Array.from(new Set(msgs.map((m) => m.from)));
}

// ============ 2026-10-01 (P1): DID 门控 —— 成员事件读写 / 白名单自检 ============

/** 读群 store 的**原始条目** (含非消息条目, 如成员事件)。打不开 → 抛 (与 groupMessages 同规矩) */
async function allRawEntries(groupId: string): Promise<Array<{ key: string; value: unknown }>> {
  let store: OrbitDBStore | null = storeCache.get(groupId) ?? null;
  if (!store) {
    const groups = await loadGroups();
    const g = groups.find((x) => x.id === groupId);
    if (!g) return [];
    store = await openGroupStore(g.address);
    if (!store) throw new GroupStoreUnreachableError(groupId, g.address, openFailures.get(groupId));
  }
  return store.all();
}

/**
 * 读本群的全部成员变更事件, 并**逐条重新验签**。
 * 没验过的事件**不算数** (进 rejected, 不进 accepted) —— 别把"库里有一条"当成"它是真的"。
 */
export async function groupMembershipEvents(groupId: string): Promise<{
  accepted: MembershipEvent[];
  rejected: Array<{ event: unknown; ok: boolean; reason: string }>;
}> {
  const raw = await allRawEntries(groupId);
  const accepted: MembershipEvent[] = [];
  const rejected: Array<{ event: unknown; ok: boolean; reason: string }> = [];
  for (const e of raw) {
    const v = e.value as any;
    if (!v || typeof v !== 'object' || v.kind !== GROUP_MEMBERSHIP_KIND) continue;
    const ev = v.event as MembershipEvent;
    const r = await verifyMembershipEvent(ev);
    if (r.ok) accepted.push(ev);
    else {
      rejected.push({ event: ev, ok: false, reason: r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | ') });
    }
  }
  accepted.sort((a, b) => a.ts - b.ts);
  return { accepted, rejected };
}

/**
 * 落一条成员变更事件 (验签不过 → 拒写, 返回 error)。
 * 注意: 能写这个 store 本身就要求调用者在白名单里 —— 本函数不代替 ACL, 只是入口处的形状/签名闸门。
 */
export async function recordMembershipEvent(
  groupId: string,
  event: MembershipEvent
): Promise<{ ok: boolean; error?: string }> {
  const v = await verifyMembershipEvent(event);
  if (!v.ok) {
    return { ok: false, error: `成员事件验签不过: ${v.checks.filter((c) => !c.ok).map((c) => c.name).join(',')}` };
  }
  let store: OrbitDBStore | null = storeCache.get(groupId) ?? null;
  if (!store) {
    const groups = await loadGroups();
    const g = groups.find((x) => x.id === groupId);
    if (!g) return { ok: false, error: '群组不存在 (先 joinGroup/createGroup)' };
    store = await openGroupStore(g.address);
    if (!store) return { ok: false, error: `群组 store 不可达: ${unreachableReason(openFailures.get(groupId))}` };
  }
  try {
    await store.add(membershipEntryOf(event));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `写成员事件失败: ${String(e?.message || e).slice(0, 160)}` };
  }
}

/**
 * 从本群库里的成员事件**派生**写白名单 (群主 + add − remove)。
 * 这就是"当前这条群地址的 ACL 应该长什么样"的**可核验答案**:
 * 拿它去和 manifest 里真正的白名单比对 (或拿它去重建一个新 store)。
 */
export async function groupWriteList(
  groupId: string,
  owner: MemberRef
): Promise<{ write: string[]; members: MemberRef[]; rejectedCount: number; gated: boolean }> {
  const groups = await loadGroups();
  const g = groups.find((x) => x.id === groupId);
  const raw = await allRawEntries(groupId);
  const events: MembershipEvent[] = [];
  for (const e of raw) {
    const v = e.value as any;
    if (v && typeof v === 'object' && v.kind === GROUP_MEMBERSHIP_KIND && v.event) events.push(v.event as MembershipEvent);
  }
  const applied = await applyMembershipEvents({ owner, events });
  const gated = !!(g?.gated || applied.accepted.length > 0);
  // 非门控的老群 (write:['*']) 派生不出成员白名单 —— 如实标 gated:false, 不硬凑
  return { write: applied.write, members: applied.members, rejectedCount: applied.rejected.length, gated };
}

/** 发送群消息 (广播给所有成员) */
export async function groupSend(
  groupId: string,
  text: string,
  from: string,
  opts?: { lang?: string; mentions?: string[]; replyTo?: string; attachments?: GroupAttachment[]; branch?: string; kind?: string }
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const msg = String(text || '').trim();
  if (!msg) return { ok: false, error: '消息不能为空' };
  let store: OrbitDBStore | null = storeCache.get(groupId) ?? null;
  if (!store) {
    const groups = await loadGroups();
    const g = groups.find((x) => x.id === groupId);
    if (!g) return { ok: false, error: '群组不存在 (先 joinGroup)' };
    store = await openGroupStore(g.address);
    if (!store) {
      return { ok: false, error: `群组 store 不可达: ${unreachableReason(openFailures.get(groupId))}` };
    }
  }
  try {
    const record: Record<string, unknown> = { from: String(from || 'anonymous'), text: msg, ts: Date.now() };
    // 只有显式给了合法声明才写字段 —— 不给就不写 (老读者读到的东西一字不变)
    const lang = typeof opts?.lang === 'string' ? opts.lang.trim() : '';
    if (lang) record.lang = lang;
    // 2026-10-02: 与 lang 同口径 —— **只有显式给了合法形状才写字段** (不给就不写, 老读者读到的一字不变)
    const mentions = Array.isArray(opts?.mentions)
      ? opts!.mentions!.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 20)
      : [];
    if (mentions.length) record.mentions = mentions;
    const replyTo = typeof opts?.replyTo === 'string' ? opts.replyTo.trim() : '';
    if (replyTo) record.replyTo = replyTo.slice(0, 200);
    const branch = typeof opts?.branch === 'string' ? opts.branch.trim() : '';
    if (branch) record.branch = branch.slice(0, 120);
    const attachments = Array.isArray(opts?.attachments)
      ? opts!.attachments!
          .filter((a) => a && typeof a.cid === 'string' && a.cid.trim() && /^(image|audio|file)$/.test(String(a.kind)))
          .slice(0, 8)
          .map((a) => ({
            kind: a.kind,
            cid: String(a.cid).trim(),
            ...(a.name ? { name: String(a.name).slice(0, 120) } : {}),
            ...(typeof a.bytes === 'number' && Number.isFinite(a.bytes) ? { bytes: a.bytes } : {}),
          }))
      : [];
    if (attachments.length) record.attachments = attachments;
    const kind = typeof opts?.kind === 'string' ? opts.kind.trim() : '';
    if (kind) record.kind = kind.slice(0, 40);
    // 2026-10-02: 回传本条消息的 id —— 回复/建分支都要锚点 (拿不到就不给字段, 不假造)
    const entry = (await store.add(record)) as { hash?: unknown; id?: unknown } | undefined;
    const id = String(entry?.hash ?? entry?.id ?? '').trim();
    return id ? { ok: true, id } : { ok: true };
  } catch (e: any) {
    return { ok: false, error: `发送失败: ${String(e?.message || e).slice(0, 160)}` };
  }
}

/**
 * 2026-09-28: 按语言裁决发群消息 —— 真可走的那条路。
 *
 * 双方都声明 efficode ⇒ 正文真编成 Efficode 包 (文本模式 Base64), `lang: 'efficode'` 一起落库;
 * 否则**原文直发** + `lang: 'natural'` (或干脆不写字段, 由调用方定), 并记一笔回落原因。
 * 裁决/编码/落库各自失败都有结构化结果, 不静默。
 */
export async function groupSendWithLang(
  groupId: string,
  text: string,
  from: string,
  opts: { mine: unknown; theirs: unknown; op?: OpSymbol; record?: 'always' | 'on-fallback' } = { mine: undefined, theirs: undefined }
): Promise<{
  ok: boolean;
  error?: string;
  lang: AgentLang;
  bytes: number;
  fallback: boolean;
  reason: string;
  symbolic: string;
}> {
  const enc = encodeForPeer({ text, mine: opts.mine, theirs: opts.theirs, from, op: opts.op });
  recordLangDecision(enc.decision, { channel: `group:${groupId}`, peer: from });
  const wantLang = enc.lang === 'efficode' || opts.record === 'always' ? enc.lang : '';
  const r = await groupSend(groupId, enc.text, from, wantLang ? { lang: wantLang } : undefined);
  return {
    ok: r.ok,
    error: r.error,
    lang: enc.lang,
    bytes: enc.bytes,
    fallback: enc.decision.fallback,
    reason: enc.decision.reason,
    symbolic: enc.symbolic,
  };
}

/**
 * 2026-09-28: 读一条群消息 —— 严格按它自己声明的 `lang` 分派。
 * 声明不是 efficode (含未知字符串 / 没声明) ⇒ 原样返回, **不进解码器**。
 * 声明 efficode 且本机也声明支持 ⇒ 真解包 (畸形包抛, 由调用方如实报失败)。
 */
export function readGroupMessage(msg: GroupMessage, mine: unknown): IncomingResult {
  return decodeFromPeer({ payload: msg.text, declaredLang: msg.lang, mine });
}

/** 群组邀请链接 */
export async function groupLink(groupId: string): Promise<string | null> {
  const groups = await loadGroups();
  return groups.find((g) => g.id === groupId)?.link ?? null;
}

/** 群组信息 (含成员数/消息数) */
export async function groupInfo(groupId: string): Promise<GroupInfo | null> {
  const groups = await loadGroups();
  const g = groups.find((x) => x.id === groupId);
  if (!g) return null;
  const msgs = await groupMessages(groupId, 500);
  const members = await groupMembers(groupId);
  return { ...g, messageCount: msgs.length, memberCount: members.length };
}

/** 重启恢复: 重开所有已加入群组的 store (失败静默) */
export async function restoreGroups(): Promise<{ restored: number; failed: number; total: number }> {
  const groups = await loadGroups();
  if (groups.length === 0) return { restored: 0, failed: 0, total: 0 };
  let restored = 0;
  let failed = 0;
  for (const g of groups) {
    const store = await openGroupStore(g.address).catch(() => null);
    if (store) restored++;
    else failed++;
  }
  return { restored, failed, total: groups.length };
}
