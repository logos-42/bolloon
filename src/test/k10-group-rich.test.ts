/**
 * k10-group-rich.test.ts — 2026-10-02 (leo: 「群里的功能包括 @成员 / 回复某条 / 发图片音频 / 建分支,
 *   不能只有这么一两个工具啊」)
 *
 * 判据四段:
 *   A. **老读者读到的一字不变** —— 不带富字段发送时, 记录里**不许**多出任何键 (最重要的一条);
 *   B. 带富字段 ⇒ 记录里有, 且形状只许是合法的 (脏值当没声明, 不修补);
 *   C. 读回透传: id / mentions / replyTo / attachments / branch / kind 能原样读到; 脏记录被剔;
 *   D. 隐私闸管到 @ —— mentions 里塞 DID/地址形态 ⇒ 整条拒绝发 (不许从 @ 漏出去);
 *   E. 工具在册: group_join/list/read/say/reply/attach/branch/members 八个 + 发言走唯一出口。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  createGroup,
  groupSend,
  groupMessages,
  setGroupTestDb,
  resetGroupState,
} from '../agents/gateway-group.js';
import { sendTrailMessage } from '../agents/task-group.js';
import type { CIDDatabase, OrbitDBStore } from '../orbitdb/cid-database.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-grp-rich-' + Date.now());
const fakeHome = path.join(tmpRoot, 'home');

/** fake events store: add 追加并回一个带 hash 的条目 (id 锚点走这条) */
function makeFakeStore(address: string): OrbitDBStore & { data: any[] } {
  const data: any[] = [];
  return {
    address,
    data,
    put: async () => {},
    // 2026-10-02: 回 { hash } —— groupSend 靠它给回复/分支提供锚点
    add: async (v: unknown) => { data.push(v); return { hash: `h${data.length}` } as never; },
    all: async () => data.map((v, i) => ({ key: `msg-${i}`, hash: `h${i + 1}`, value: v })),
    get: async () => null,
    onChange: () => () => {},
  } as never;
}

function makeFakeDb(store: OrbitDBStore): CIDDatabase {
  return {
    ensure: async () => ({ helia: {} as never, orbitdb: {} as never, identityId: 'test', dataDir: fakeHome }),
    save: async () => ({ ok: true } as never),
    load: async () => null,
    share: async (cid: string) => cid,
    has: async () => false,
    list: async () => [],
    delete: async () => true,
    close: async () => {},
    info: async () => ({ dataDir: fakeHome, identityId: 'test', peers: 0, initialized: true }),
    subscribe: () => () => {},
    openStore: async () => store,
    putBytes: async (bytes: Uint8Array<ArrayBuffer>) => ({ cid: 'bafytestcid', bytes: bytes.length }),
    getBytes: async () => null,
  } as never;
}

let store: OrbitDBStore & { data: any[] };
let groupId: string;

beforeEach(async () => {
  resetGroupState();
  await fs.mkdir(path.join(fakeHome, '.bolloon'), { recursive: true });
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  store = makeFakeStore('orbitdb:///orbitdb/zdpuRichTest');
  setGroupTestDb(makeFakeDb(store));
  const r = await createGroup('富字段测试', 'me');
  groupId = (r as { group: { id: string } }).group.id;
});

afterEach(async () => {
  resetGroupState();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('A. 不带富字段 ⇒ 记录里一个键都不许多 (老读者读到的一字不变)', () => {
  it('send(group, text, from) ⇒ 键集只许是 from/text/ts', async () => {
    await groupSend(groupId, '普通一句', 'me');
    const rec = store.data[store.data.length - 1];
    expect(Object.keys(rec).sort()).toEqual(['from', 'text', 'ts']);
    expect(rec).toEqual({ from: 'me', text: '普通一句', ts: rec.ts });
  });

  it('空数组/空串/无效 kind 一律当"没给" ⇒ 仍然不许多键', async () => {
    await groupSend(groupId, 'x', 'me', { mentions: [], replyTo: '   ', branch: '', attachments: [] });
    const rec = store.data[store.data.length - 1];
    expect(Object.keys(rec).sort()).toEqual(['from', 'text', 'ts']);
  });
});

describe('B. 带了就必须写对 (形状只许合法值)', () => {
  it('mentions/replyTo/branch/kind/attachments 原样落进记录', async () => {
    await groupSend(groupId, '看这张图', 'me', {
      mentions: ['委托方', ' 审稿人 '],
      replyTo: 'h7',
      branch: '设计讨论',
      attachments: [{ kind: 'image', cid: 'bafyimg', name: 'a.png', bytes: 12 }],
    });
    const rec = store.data[store.data.length - 1];
    expect(rec.mentions).toEqual(['委托方', '审稿人']);   // trim 过
    expect(rec.replyTo).toBe('h7');
    expect(rec.branch).toBe('设计讨论');
    expect(rec.attachments).toEqual([{ kind: 'image', cid: 'bafyimg', name: 'a.png', bytes: 12 }]);
  });

  it('夹带的脏附件 (非法 kind / 空 cid) 被剔掉; 全脏 ⇒ 干脆不写 attachments', async () => {
    await groupSend(groupId, 'x', 'me', {
      attachments: [
        { kind: 'image', cid: 'good' },
        { kind: 'exe' as never, cid: 'badkind' },
        { kind: 'file', cid: '   ' },
      ],
    });
    const rec = store.data[store.data.length - 1];
    expect(rec.attachments).toEqual([{ kind: 'image', cid: 'good' }]);

    await groupSend(groupId, 'y', 'me', { attachments: [{ kind: 'nope' as never, cid: 'x' }] });
    expect(Object.keys(store.data[store.data.length - 1])).not.toContain('attachments');
  });
});

describe('C. 读回: 富字段透传 + id 锚点; 脏记录被剔 (不修补)', () => {
  it('写进去能原样读回来 (含 store 条目 id)', async () => {
    await groupSend(groupId, '带结构的一句', 'me', { mentions: ['A'], replyTo: 'h1', branch: 'B支' });
    const msgs = await groupMessages(groupId, 10);
    const m = msgs[msgs.length - 1];
    expect(m.text).toBe('带结构的一句');
    expect(m.mentions).toEqual(['A']);
    expect(m.replyTo).toBe('h1');
    expect(m.branch).toBe('B支');
    expect(m.id).toMatch(/^h\d+$/);          // ← 回复/分支要的锚点
  });

  it('脏字段不进结果: mentions 非数组 / 附件 kind 非法 ⇒ 当没声明', async () => {
    await groupSend(groupId, '脏的', 'me');
    store.data[store.data.length - 1].mentions = 'not-an-array';
    store.data[store.data.length - 1].attachments = [{ kind: 'exe', cid: 'x' }, { kind: 'audio', cid: 'ok' }];
    const m = (await groupMessages(groupId, 10)).pop()!;
    expect(m.mentions).toBeUndefined();
    expect(m.attachments).toEqual([{ kind: 'audio', cid: 'ok' }]);
  });
});

describe('D. 隐私闸管到 @ (mentions 里塞 DID/地址形态 ⇒ 整条拒绝)', () => {
  it('干净 mention ⇒ 发出去; 像 DID 的 mention ⇒ 拒发 + 报违规', async () => {
    const ok = await sendTrailMessage(groupId, '请评审', 'me', { mentions: ['审稿人'] });
    expect(ok.ok).toBe(true);
    expect(typeof ok.id).toBe('string');     // 富消息也要给锚点

    const bad = await sendTrailMessage(groupId, '请评审', 'me', { mentions: ['did:key:z6MkTestAddrHere'] });
    expect(bad.ok).toBe(false);
    expect(bad.sent).toBe(false);
    expect(bad.error).toContain('@');
    expect((bad.violations ?? []).length).toBeGreaterThan(0);
  });
});

describe('E. 工具在册 (八个) + 关键接线', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk-tools.ts'), 'utf8');
  it('group_join/list/read/say/reply/attach/branch/members 都注册了', () => {
    for (const t of ['join', 'list', 'read', 'say', 'reply', 'attach', 'branch', 'members']) {
      expect(src, `缺工具 group_${t}`).toMatch(new RegExp(`ctx\\.tools\\.set\\('group_${t}'`));
    }
  });
  it('发言/回复都走唯一出口 (带隐私闸), 附件走内容寻址 putBytes, 读带 branch 过滤', () => {
    expect(src).toMatch(/sendTrailMessage\(res\.group\.groupId, text, who\.tag, \{/);            // say 带富字段
    expect(src).toMatch(/sendTrailMessage\(res\.group\.groupId, text, who\.tag, \{ replyTo/);     // reply
    expect(src).toMatch(/db\.putBytes\(new Uint8Array\(buf\)/);                                   // attach 入库
    expect(src).toMatch(/msgs = msgs\.filter\(\(m\) => String\(m\.branch \?\? ''\) === branch\)/); // read 过滤
  });
  it('回复锚点: 适配器 all() 把条目 hash/id 透出来 (真机第一次跑就是这里丢的)', () => {
    const cid = readFileSync(path.join(process.cwd(), 'src/orbitdb/cid-database.ts'), 'utf8');
    expect(cid).toMatch(/id: String\(\(e\.hash \?\? e\.id/);
    expect(cid).toMatch(/id\?: string; value: unknown/);
  });

  it('@ 的归一: 模型给字符串/逗号串也收 (真机第一次跑, 传的就是字符串 ⇒ 按形状丢掉是错的)', () => {
    expect(src).toMatch(/const normalizeMentions = \(raw: unknown\)/);
    expect(src).toMatch(/typeof raw === 'string' \? raw\.split\(\/\[,，;；/);
    expect(src).toMatch(/normalizeMentions\(args\?\.mentions\)/);
    expect(src).toMatch(/\.replace\(\/\^@\/, ''\)/);   // 顺手吃掉前缀 @
  });

  it('内容寻址层有原始字节入口 (raw 0x55 + sha256), 不是把二进制包成 dag-cbor', () => {
    const cid = readFileSync(path.join(process.cwd(), 'src/orbitdb/cid-database.ts'), 'utf8');
    expect(cid).toMatch(/export async function bytesToCid/);
    expect(cid).toMatch(/CID\.createV1\(0x55/);
    expect(cid).toMatch(/async putBytes\(/);
    expect(cid).toMatch(/async getBytes\(/);
  });
});
