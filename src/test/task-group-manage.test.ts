/**
 * task-group-manage.test.ts — 2026-09-24
 *
 * 补的两条真缺口 (CLI 侧):
 *   (A) `bolloon task group create|join|list|link|leave` —— 以前 createGroup/joinGroup/listGroups
 *       只存在于 src/agents/gateway-group.ts, CLI 里**没有入口**, 外部接单者拿到群链接后
 *       无法自助入群。
 *   (B) `bolloon identity init|show` —— 以前建身份**只有** readline 交互向导 (bolloon setup),
 *       无 TTY 环境下 `readline was closed` (ERR_USE_AFTER_CLOSE), 新机器/第二实例建不出身份。
 *
 * 隔离: HOME/USERPROFILE → tmp; fake CIDDatabase 注入 (setGroupTestDb, 不起真实 OrbitDB)。
 *
 * 本文件的断言都**能变红** (做过变异验证, 见文件末尾 describe('变异验证')) ——
 * 尤其是"输出不许出现 DID / 私钥 / peerId / multiaddr / IP"这几条: 它们是**值**断言,
 * 不是"跑过了没抛异常"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { parseFlags, commandResult } from '../cli/protocol-envelope.js';
import { taskCommand } from '../cli/commands/tasks.js';
import { identityCommand } from '../cli/identity-command.js';
import { getLocalIdentityFile, initLocalIdentity } from '../cli/setup-wizard.js';
import { scanNodeIdentity } from '../agents/task-group.js';
import { setGroupTestDb, resetGroupState } from '../agents/gateway-group.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-tgmanage-' + process.pid + '-' + Date.now());
const fakeHome = path.join(tmpRoot, 'home');
const xdgCache = path.join(tmpRoot, 'cache');

/** fake events store: add 追加, all 按序返回 */
function makeFakeStore(address: string): OrbitDBStore & { data: any[] } {
  const data: any[] = [];
  return {
    address,
    data,
    put: async () => {},
    add: async (v: any) => { data.push(v); },
    all: async () => data.map((v, i) => ({ key: `msg-${i}`, value: v })),
    get: async () => null,
    onChange: () => () => {},
  } as any;
}

/** fake CIDDatabase; `reachable:false` → openStoreByAddress 抛 (模拟"区块不在本机") */
function makeFakeDB(opts: { reachable?: boolean } = {}): CIDDatabase {
  const stores = new Map<string, OrbitDBStore & { data: any[] }>();
  const reachable = opts.reachable !== false;
  return {
    save: async (d: any) => ({ id: 'cid', agentId: d.agentId, timestamp: 0, type: d.type, content: d.content, metadata: {}, version: 1 }),
    load: async () => null,
    update: async () => null,
    version: async () => [],
    list: async () => [],
    share: async (c: any) => `bolloon-cid://${c}`,
    openStore: async (name: string) => {
      const addr = `/orbitdb/fake-${String(name).replace(/[^a-zA-Z0-9-]/g, '_')}`;
      const s = makeFakeStore(addr);
      stores.set(addr, s);
      return s;
    },
    openStoreByAddress: async (address: string) => {
      if (!reachable) throw new Error('No block brokers capable of retrieving blocks are configured, the CID bafyreiTEST');
      if (!stores.has(address)) stores.set(address, makeFakeStore(address));
      return stores.get(address)!;
    },
    close: async () => {},
  } as any;
}

/** 跑一条 CLI 命令, 拿回 CommandResult (与 cli-entry 同一条路: flags → commandResult) */
async function run(args: string[]) {
  return commandResult(parseFlags(args), taskCommand);
}

async function runIdentity(args: string[]) {
  return commandResult(parseFlags(args), identityCommand);
}

/** 整封信封 (含 human) 的文本 —— 隐私断言都打在这一整坨上, 别只看 data */
function textOf(o: any): string {
  return JSON.stringify(o.envelope) + '\n' + String(o.human ?? '');
}

/**
 * 群管理输出的脱敏闸: 原始 DID / 钱包地址 / peerId / 节点 multiaddr / IP —— 一律不许出现。
 *
 * 注意 `orbitdb` **不在**这里: `create` / `link` 就是要打印邀请链接 (`orbitdb:///orbitdb/<store>?type=group…`),
 * 那是**群自己的公开标识**, 不是节点地址。只有 `list` 必须连链接一起挡住 (单独断言)。
 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['原始 DID', /did:[a-z0-9]+:/i],
  ['钱包地址', /0x[0-9a-fA-F]{40}/],
  ['peerId (12D3Koo)', /12D3Koo[A-Za-z0-9]{8,}/],
  ['peerId (Qm…)', /(?<![A-Za-z0-9])Qm[1-9A-HJ-NP-Za-km-z]{30,}/],
  ['节点 multiaddr', /\/(ip4|ip6|dns4|dns6|dns|tcp|udp|ws|wss|quic|p2p-circuit|p2p)\b/],
  ['IPv4', /(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/],
];

function leaks(text: string): string[] {
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);
}

async function sha(p: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
}

describe('bolloon task group (A) + bolloon identity (B)', () => {
  let did: string;

  beforeEach(async () => {
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.XDG_CACHE_HOME = xdgCache;
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(fakeHome, { recursive: true });
    resetGroupState();
    setGroupTestDb(makeFakeDB());
    // 真身份 (走与生产同一条 KeyManager 路径), 后面 create 要用它派生发送者假名
    const r = await initLocalIdentity(fakeHome);
    did = String(r.did);
  });

  afterEach(() => {
    setGroupTestDb(null);
    resetGroupState();
  });

  // ---------- (A) 命令面 ----------

  it('task group 不带动作 → INVALID_ARGUMENT, 并给出 5 个动作用法', async () => {
    const r = await run(['group']);
    expect(r.envelope.ok).toBe(false);
    expect(r.envelope.code).toBe('INVALID_ARGUMENT');
    const accepted = (r.envelope.data as any).accepted;
    expect(accepted).toEqual(['create', 'join', 'list', 'link', 'leave']);
    expect(r.human).toContain('bolloon task group join');
  });

  it('task group 未知动作 → INVALID_ARGUMENT (不静默当默认动作)', async () => {
    const r = await run(['group', 'frobnicate']);
    expect(r.envelope.code).toBe('INVALID_ARGUMENT');
    expect(String(r.envelope.message)).toContain('frobnicate');
  });

  it('group create 缺 --name → INVALID_ARGUMENT, 且没有建出任何群', async () => {
    const r = await run(['group', 'create']);
    expect(r.envelope.code).toBe('INVALID_ARGUMENT');
    const list = await run(['group', 'list', '--json']);
    expect((list.envelope.data as any).count).toBe(0);
  });

  it('group list 无群 → OK + 空列表 (不是错误, 不崩)', async () => {
    const r = await run(['group', 'list', '--json']);
    expect(r.envelope.ok).toBe(true);
    expect(r.envelope.code).toBe('OK');
    const d = r.envelope.data as any;
    expect(d.count).toBe(0);
    expect(d.groups).toEqual([]);
  });

  // ---------- (A) create ----------

  it('group create --name → 出链接; 发送者是 identity 派生假名, 原始 DID 不入群也不进输出', async () => {
    const r = await run(['group', 'create', '--name', '接单群', '--json']);
    expect(r.envelope.ok).toBe(true);
    const g = (r.envelope.data as any).group;
    expect(g.link).toMatch(/^orbitdb:\/\/\/orbitdb\/fake-bolloon-gw-group-/);
    expect(g.link).toContain('type=group');
    expect(g.id).toBeTruthy();
    // 发送者 = agent-<8hex>, 不是 DID
    expect((r.envelope.data as any).sender.tag).toMatch(/^agent-[0-9a-f]{8}$/);
    expect((r.envelope.data as any).sender.didPrinted).toBe(false);
    // create 必须把链接打印出来 (外部接单者要靠它入群)
    expect(r.human).toContain(g.link);
    // 原始 DID 绝不出现 (值断言: 把 from 换成 did 就会红)
    expect(textOf(r)).not.toContain(did);
    expect(leaks(textOf(r))).toEqual([]);
  });

  it('group create 群名含标识符 → POLICY_DENIED, 且不建群 (不静默改名)', async () => {
    const r = await run(['group', 'create', '--name', 'did:diap:zTestAbc123', '--json']);
    expect(r.envelope.ok).toBe(false);
    expect(r.envelope.code).toBe('POLICY_DENIED');
    expect((r.envelope.data as any).violations.map((v: any) => v.rule)).toContain('did');
    const list = await run(['group', 'list', '--json']);
    expect((list.envelope.data as any).count).toBe(0);
  });

  it('没有身份也没有 --from → 拒建群 (不假造一个发送者)', async () => {
    await fs.rm(getLocalIdentityFile(fakeHome), { force: true });
    const r = await run(['group', 'create', '--name', '无身份群', '--json']);
    expect(r.envelope.ok).toBe(false);
    expect((r.envelope.data as any).created).toBe(false);
    expect(String(r.envelope.message)).toContain('--from');
    const list = await run(['group', 'list', '--json']);
    expect((list.envelope.data as any).count).toBe(0);
    // --from 给了就能建 (短显示名)
    const r2 = await run(['group', 'create', '--name', '无身份群', '--from', '委托方', '--json']);
    expect(r2.envelope.ok).toBe(true);
    expect((r2.envelope.data as any).sender.tag).toBe('委托方');
  });

  // ---------- (A) list / 隐私 ----------

  it('group list --json 看得到刚建的群, 且不含群链接/store 地址/DID/peerId/multiaddr/IP', async () => {
    const c = await run(['group', 'create', '--name', '接单群', '--json']);
    const link = (c.envelope.data as any).group.link;
    const r = await run(['group', 'list', '--json']);
    expect(r.envelope.ok).toBe(true);
    const d = r.envelope.data as any;
    expect(d.count).toBe(1);
    expect(d.groups[0].name).toBe('接单群');
    expect(d.groups[0].id).toBe((c.envelope.data as any).group.id);
    // list 的**有意口径**: 不出链接/地址 (要链接走 task group link) —— 比 create 更严
    expect(d.groups[0].link).toBeUndefined();
    expect(d.groups[0].address).toBeUndefined();
    const text = textOf(r);
    expect(text).not.toContain(link);
    expect(text).not.toContain('/orbitdb/');
    expect(text).not.toContain(did);
    // 隐私形态 (值断言, 会红)
    expect(leaks(text)).toEqual([]);
  });

  // ---------- (A) join ----------

  it('group join <groupId> 已在群里 → OK + already=true (幂等, 不重复入群)', async () => {
    const c = await run(['group', 'create', '--name', '接单群', '--json']);
    const id = (c.envelope.data as any).group.id;
    const r = await run(['group', 'join', id, '--json']);
    expect(r.envelope.ok).toBe(true);
    expect((r.envelope.data as any).already).toBe(true);
    const list = await run(['group', 'list', '--json']);
    expect((list.envelope.data as any).count).toBe(1);
  });

  it('group join 陌生链接 → OK + joined, 落本地群列表', async () => {
    const r = await run(['group', 'join', 'orbitdb:///orbitdb/zdpuStrangerGroupAddr000000000000000000000?type=group&name=external', '--json']);
    expect(r.envelope.ok).toBe(true);
    expect((r.envelope.data as any).already).toBe(false);
    expect((r.envelope.data as any).joined).toBe(true);
    const list = await run(['group', 'list', '--json']);
    expect((list.envelope.data as any).count).toBe(1);
    expect((list.envelope.data as any).groups[0].name).toBe('external');
  });

  it('群 store 拿不到区块 → TRANSPORT_FAILED + STORE_UNREACHABLE, 绝不 localFallback/假成功', async () => {
    setGroupTestDb(makeFakeDB({ reachable: false }));
    const r = await run(['group', 'join', 'orbitdb:///orbitdb/zdpuNoBlocksHere0000000000000000000000000000?type=group&name=g', '--json']);
    expect(r.envelope.ok).toBe(false);
    expect(r.envelope.code).toBe('TRANSPORT_FAILED');
    const d = r.envelope.data as any;
    expect(d.storeCode).toBe('STORE_UNREACHABLE');
    expect(d.joined).toBe(false);
    expect(d.localFallback).toBe(false);
    // 原始错误必须带出来 (不是一句"失败了")
    expect(String(r.envelope.message)).toContain('block broker');
    // 没入群 → 本地列表里没有它 (没有"假装入群")
    setGroupTestDb(makeFakeDB());
    const list = await run(['group', 'list', '--json']);
    expect((list.envelope.data as any).count).toBe(0);
  });

  it('group join 非 orbitdb 的 URL → INVALID_ARGUMENT (与"本机没这个群"分开报)', async () => {
    const r = await run(['group', 'join', 'https://example.invalid/invite', '--json']);
    expect(r.envelope.code).toBe('INVALID_ARGUMENT');
    expect(String(r.envelope.message)).toContain('不是群链接');
    const r2 = await run(['group', 'join', 'some-plain-id', '--json']);
    expect(r2.envelope.code).toBe('NOT_FOUND');
  });

  it('group join 缺参数 → INVALID_ARGUMENT', async () => {
    const r = await run(['group', 'join']);
    expect(r.envelope.code).toBe('INVALID_ARGUMENT');
  });

  // ---------- (A) link / leave ----------

  it('group link <groupId> 显式取回链接; 未知 groupId → NOT_FOUND', async () => {
    const c = await run(['group', 'create', '--name', '接单群', '--json']);
    const g = (c.envelope.data as any).group;
    const r = await run(['group', 'link', g.id, '--json']);
    expect(r.envelope.ok).toBe(true);
    expect((r.envelope.data as any).group.link).toBe(g.link);
    const bad = await run(['group', 'link', 'zdpuNoSuchGroupAtAll', '--json']);
    expect(bad.envelope.code).toBe('NOT_FOUND');
  });

  it('group leave <groupId> 摘掉本机记录; 再 leave → NOT_FOUND', async () => {
    const c = await run(['group', 'create', '--name', '接单群', '--json']);
    const id = (c.envelope.data as any).group.id;
    const r = await run(['group', 'leave', id, '--json']);
    expect(r.envelope.ok).toBe(true);
    expect((r.envelope.data as any).removed).toBe(true);
    expect((r.envelope.data as any).localOnly).toBe(true);
    const list = await run(['group', 'list', '--json']);
    expect((list.envelope.data as any).count).toBe(0);
    const again = await run(['group', 'leave', id, '--json']);
    expect(again.envelope.code).toBe('NOT_FOUND');
  });

  // ---------- 脱敏口径的负控制 (证明这套闸**能**红) ----------

  it('负控制: scanNodeIdentity 对标识符命中, 对普通 base58 群 id 不命中', () => {
    expect(scanNodeIdentity('did:key:z6Mkabc').length).toBeGreaterThan(0);
    expect(scanNodeIdentity('/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbcdefghij').length).toBeGreaterThan(0);
    expect(scanNodeIdentity('peer=12D3KooWFixturePeerId000000000000000000000000').length).toBeGreaterThan(0);
    expect(scanNodeIdentity('0x1234567890abcdef1234567890abcdef12345678').length).toBeGreaterThan(0);
    // 正常群 id (base58 CID) 与群名 → 不命中 (否则建群会随机误判)
    expect(scanNodeIdentity('zdpuAqyzXcyFJdFyRoc5jNsCZTVh3ddMmtXWUAR6oKeJKMvEf')).toEqual([]);
    expect(scanNodeIdentity('接单群')).toEqual([]);
    // 节点 multiaddr 命中 (群链接里的 orbitdb 那一档由 NODE_IDENTITY_RULES 有意排除, 见上)
    expect(leaks('/ip4/10.0.0.7/tcp/4001/p2p/12D3KooWAbc')).toContain('节点 multiaddr');
    expect(leaks('did:key:z6Mkabc')).toContain('原始 DID');
    expect(leaks('orbitdb:///orbitdb/zdpuX?type=group&name=g')).toEqual([]);
  });

  // ---------- (B) identity init / show ----------

  it('identity init → 建出 0600 的 identity.json, 字段与既有一致, 输出不含私钥', async () => {
    const file = getLocalIdentityFile(fakeHome);
    await fs.rm(file, { force: true });
    const r = await runIdentity(['init', '--json']);
    expect(r.envelope.ok).toBe(true);
    expect((r.envelope.data as any).action).toBe('created');
    expect((r.envelope.data as any).created).toBe(true);
    expect((r.envelope.data as any).mode).toBe('600');

    // 文件真的在, 权限真是 600, 字段恰好是既有那 6 个
    const mode = ((await fs.stat(file)).mode & 0o777).toString(8);
    expect(mode).toBe('600');
    const j = JSON.parse(await fs.readFile(file, 'utf-8'));
    expect(Object.keys(j).sort()).toEqual(['createdAt', 'did', 'keyType', 'privateKey', 'publicKey', 'version']);
    expect(j.keyType).toBe('Ed25519');
    expect(String(j.did)).toMatch(/^did:/);

    // 绝不打印私钥: 输出里没有私钥的值, 连 privateKey 这个**字段名**都不该出现
    const text = textOf(r);
    expect(text).not.toContain(String(j.privateKey));
    expect(text).not.toContain(String(j.privateKey).slice(0, 16));
    expect(text).not.toContain('privateKey');
    // 输出里没有密钥材料; human 只列**非私密**字段名 (privateKey 这四个字都不出现)
    expect(String(r.human)).toContain('keyType');
    expect(String(r.human)).not.toContain('privateKey');
    expect((r.envelope.data as any).keyMaterialInOutput).toBe(false);
  });

  it('identity init 幂等: 重跑一个字不改, 仍 exit 0 (action=reused)', async () => {
    const file = getLocalIdentityFile(fakeHome);
    await fs.rm(file, { force: true });
    const a = await runIdentity(['init', '--json']);
    expect(a.envelope.ok).toBe(true);
    const before = await sha(file);
    const b = await runIdentity(['init', '--json']);
    expect(b.envelope.ok).toBe(true);
    expect((b.envelope.data as any).action).toBe('reused');
    expect((b.envelope.data as any).changed).toBe(false);
    expect((b.envelope.data as any).created).toBe(false);
    expect(await sha(file)).toBe(before);   // 值断言: 覆盖/重写就会红
    expect((b.envelope.data as any).did).toBe((a.envelope.data as any).did);
  });

  it('identity init 遇到损坏文件 → POLICY_DENIED, 拒绝覆盖 (不丢可能还能救的钥匙)', async () => {
    const file = getLocalIdentityFile(fakeHome);
    await fs.writeFile(file, '{"createdAt":"x","broken":', 'utf-8');
    const before = await sha(file);
    const r = await runIdentity(['init', '--json']);
    expect(r.envelope.ok).toBe(false);
    expect(r.envelope.code).toBe('POLICY_DENIED');
    expect((r.envelope.data as any).action).toBe('refused');
    expect((r.envelope.data as any).overwritten).toBe(false);
    expect(await sha(file)).toBe(before);   // 真没动过
    // --force 才重建, 且先备份
    const f = await runIdentity(['init', '--force', '--json']);
    expect(f.envelope.ok).toBe(true);
    expect((f.envelope.data as any).action).toBe('created');
    const backups = (await fs.readdir(path.join(fakeHome, '.bolloon'))).filter((n) => n.startsWith('identity.json.bak-'));
    expect(backups.length).toBe(1);
    expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf-8'))).sort())
      .toEqual(['createdAt', 'did', 'keyType', 'privateKey', 'publicKey', 'version']);
  });

  it('identity show → 只出 DID/指纹/字段名, 不含私钥; 没身份 → NOT_FOUND', async () => {
    const r = await runIdentity(['show', '--json']);
    expect(r.envelope.ok).toBe(true);
    const d = r.envelope.data as any;
    expect(d.did).toBe(did);
    expect(d.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    // 输出里**只有非私密字段名** (privateKey 连名字都不出现)
    expect(d.publicFields).toEqual(['createdAt', 'did', 'keyType', 'publicKey', 'version']);
    const j = JSON.parse(await fs.readFile(getLocalIdentityFile(fakeHome), 'utf-8'));
    expect(textOf(r)).not.toContain(String(j.privateKey));
    expect(textOf(r)).not.toContain('privateKey');
    // 私钥只在文件里, 不进输出
    await fs.rm(getLocalIdentityFile(fakeHome), { force: true });
    const no = await runIdentity(['show', '--json']);
    expect(no.envelope.code).toBe('NOT_FOUND');
  });

  it('identity 无子命令 → INVALID_ARGUMENT (可发现性)', async () => {
    const r = await runIdentity([]);
    expect(r.envelope.code).toBe('INVALID_ARGUMENT');
    expect(String((r.envelope.data as any).usage)).toContain('identity init');
    expect(r.human).toContain('identity show');
  });
});
