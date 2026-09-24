/**
 * gateway-group.ts — Agent Gateway P2P 群组 (2026-08-14)
 *
 * 群组 = OrbitDB events store (accessController write:'*'), 任何成员可广播消息,
 * 全成员通过 OrbitDB pubsub 复制实时同步. 链接: orbitdb://<addr>?type=group&name=<群名>.
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
 */

import * as os from 'os';
import * as path from 'path';
import { getCIDDatabase, type CIDDatabase, type OrbitDBStore } from '../orbitdb/cid-database.js';

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

export interface GroupMessage {
  from: string;         // did / agentId
  text: string;
  ts: number;
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
 * 打开群组 store (缓存) — 可写 (replica=false, write:'*')。
 * 打不开 → 记下原始原因 + 返回 null (不抛: 调用方各自决定用什么话术报)。
 * 2026-09-24: 必须 try/catch —— openStoreByAddress 现在抛 OrbitDBStoreUnreachableError。
 */
async function openGroupStore(address: string): Promise<OrbitDBStore | null> {
  const id = groupIdOf(address);
  if (storeCache.has(id)) return storeCache.get(id)!;
  const db = getDb();
  let store: OrbitDBStore | null = null;
  try {
    // 2026-09-24: 不再传 `replica` —— `@orbitdb/core` 4.0.0 的 open() 没有这个参数
    // (src/orbitdb.js:118), 传了被丢; 之前那行是"不存在的语义"。
    // 可写与否由 manifest 里的 ACL 决定, 且**打开既有地址时 ACL 从 manifest 取回、
    // 入参 accessController 被覆盖** (src/orbitdb.js:129-131) —— 所以这里传什么都不改变权限。
    store = await db.openStoreByAddress(address, 'events', {
      accessController: { write: ['*'] },
    });
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
 * 创建群组: 新 events store (write:'*') + 持久化 + 生成邀请链接.
 */
export async function createGroup(name: string, opts?: { from?: string; hello?: string }): Promise<JoinGroupResult> {
  const groupName = String(name || '').trim() || `group-${Date.now().toString(36).slice(-4)}`;
  try {
    const db = getDb();
    const store = await db.openStore(`bolloon-gw-group-${groupName}`, 'events', {
      accessController: { write: ['*'] },
    });
    const address = store.address;
    const id = groupIdOf(address);
    const link = `orbitdb://${address}?type=group&name=${encodeURIComponent(groupName)}`;
    const info: GroupInfo = {
      id, name: groupName, address, link,
      createdAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
    };
    storeCache.set(id, store);
    // 欢迎消息 (群主自我介绍)
    const from = opts?.from || 'group-owner';
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
      msgs.push({ from: v.from, text: v.text, ts: typeof v.ts === 'number' ? v.ts : 0 });
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

/** 发送群消息 (广播给所有成员) */
export async function groupSend(groupId: string, text: string, from: string): Promise<{ ok: boolean; error?: string }> {
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
    await store.add({ from: String(from || 'anonymous'), text: msg, ts: Date.now() });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `发送失败: ${String(e?.message || e).slice(0, 160)}` };
  }
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
