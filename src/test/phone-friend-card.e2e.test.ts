/**
 * phone-friend-card.e2e.test.ts — 端到端验收 (2026-10-19, leo: 手机号加好友 + 对方传卡片到世界模式)
 *
 * 场景: ① 我方用手机号目录工具 (directory.lookup + directory.add_friend) 加对方好友
 *       ② 对方 (独立 DID 的智能体) 往我世界模式传一张多模态卡片 (文本/文档/音频/图片/视频)
 *       ③ 我方世界模式 (scanOpportunities) 收到卡片并验签 (reason='card', 优先级最高)
 *       ④ 桌面侧读出链路 (listWorldCards) 与 CLI 命令 (world card list) 同源
 *
 * broadcast 用 mock fetch 拦 /api/friend-request (真 P2P 握手需双进程, 单测隔离 HOME 下
 *   工具行为 = 发好友申请; 真两节点已在 verify-* 门覆盖)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { registerContactTools } from '../agents/contacts/tools.js';
import { ContactChain } from '../agents/contacts/chain.js';
import { publishEntry } from '../agents/contacts/human-directory.js';
import { deliverWorldCard, listWorldCards, CARD_PROTOCOL, canonicalCardPayload } from '../agents/world-cards.js';
import { scanOpportunities } from '../agents/opportunity-match.js';
import { ed25519Sign } from '../agents/x402/paid-info-protocol.js';

// ── 真 Ed25519 密钥对 (一方一个) ─────────────────────────────────────────────
function makeKeyPair() {
  const kp = crypto.generateKeyPairSync('ed25519');
  return {
    pub: Buffer.from(kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)),
    priv: Buffer.from(kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)),
  };
}
function didKeyFromPublicKey(pub: Buffer): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const body = Buffer.concat([Buffer.from([0xed, 0x01]), pub]);
  let num = BigInt(0);
  for (const b of body) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) { out = ALPHABET[Number(num % 58n)] + out; num /= 58n; }
  for (const b of body) { if (b === 0) out = '1' + out; else break; }
  return `did:key:z${out}`;
}

const A = makeKeyPair(); // 我方 (leoS bolloon) — DID 用于目录发布方身份 (工具链路)
const B = makeKeyPair(); // 对方智能体 — DID 用于签名投递卡片
const B_DID = didKeyFromPublicKey(B.pub);

const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;
const REAL_FETCH = globalThis.fetch;
let fakeHome: string;
let friendRequests: Array<Record<string, unknown>> = [];

async function makeFakeHome(): Promise<string> {
  const dir = path.join(os.tmpdir(), `bolloon-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeEach(async () => {
  fakeHome = await makeFakeHome();
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  friendRequests = [];
  // mock fetch — 只拦 /api/friend-request; 其余走真 (测试不会碰网络, 全本地)
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('/api/friend-request')) {
      const body = JSON.parse(String(init?.body || '{}'));
      friendRequests.push(body);
      return {
        ok: true, status: 200, json: async () => ({ ok: true, requestId: 'req-e2e-1', persistedAs: body.name || '对方' }),
      } as any;
    }
    if (url.includes('/api/')) {
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'mock: 未注册端点 ' + url }) } as any;
    }
    return REAL_FETCH(input, init);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = REAL_FETCH;
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(fakeHome, { recursive: true, force: true });
});

describe('手机号加好友 → 对方传卡片到世界模式 (端到端)', () => {
  it('目录 lookup 命中 → add_friend 发出好友申请 (带对方 publicKeyHex)', async () => {
    // 对方先发布手机号目录 (独立 DID + 真 publicKeyHex)
    await publishEntry('13812345678', B_DID, { displayName: '对方智能体', publicKeyHex: B.pub.toString('hex') });
    // 我方注册联系工具
    const tools = new Map<string, any>();
    registerContactTools({ tools } as any, new ContactChain({ home: fakeHome, ownerDid: 'did:e2e:a', displayName: 'leo' }));

    // lookup 工具
    const look = await tools.get('directory.lookup')!.execute({ phone: '13812345678' });
    expect(look.success).toBe(true);
    expect(look.found).toBe(true);
    expect(look.did).toBe(B_DID);
    expect(look.publicKeyHex).toBe(B.pub.toString('hex'));

    // add_friend 工具 (默认主动)
    const add = await tools.get('directory.add_friend')!.execute({ phone: '13812345678', message: '我是 leo, 加个好友' });
    expect(add.success).toBe(true);
    expect(add.requestId).toBe('req-e2e-1');
    // 好友申请真的发出去了, 且 target = 对方公钥 (不是自己/不是空)
    expect(friendRequests).toHaveLength(1);
    expect(friendRequests[0].targetPublicKey).toBe(B.pub.toString('hex'));
    expect(friendRequests[0].name).toBe('对方智能体');
    expect(friendRequests[0].note).toBe('via-phone-directory');
  });

  it('手机号未发布目录 → lookup 未命中, add_friend 拒绝 (不瞎发申请)', async () => {
    const tools = new Map<string, any>();
    registerContactTools({ tools } as any, new ContactChain({ home: fakeHome, ownerDid: 'did:e2e:a', displayName: 'leo' }));
    const look = await tools.get('directory.lookup')!.execute({ phone: '13900000000' });
    expect(look.found).toBe(false);
    const add = await tools.get('directory.add_friend')!.execute({ phone: '13900000000' });
    expect(add.success).toBe(true); // 工具本身成功 (found:false 语义)
    expect(add.found).toBe(false);
    expect(friendRequests).toHaveLength(0); // 没发申请
  });

  it('对方智能体签名投递多模态卡片 → 我方世界模式收到 (reason=card, 验签通过, media 4 类齐全)', async () => {
    // 对方用自己身份签名投递一张卡片
    const payload = {
      protocol: CARD_PROTOCOL,
      title: '本周设计稿交付',
      summary: '含设计文档、预览图、演示视频与语音说明。',
      media: [
        { type: 'text', url: 'ipfs://QmX/design.md', mime: 'text/markdown', name: 'design.md' },
        { type: 'image', url: 'ipfs://QmX/preview.png', mime: 'image/png', name: 'preview.png' },
        { type: 'audio', url: 'ipfs://QmX/voice.mp3', mime: 'audio/mpeg', name: 'voice.mp3' },
        { type: 'video', url: 'ipfs://QmX/demo.mp4', mime: 'video/mp4', name: 'demo.mp4' },
      ],
      provider: { did: B_DID, name: '对方智能体' },
      issuedAt: new Date().toISOString(),
    };
    const sig = await ed25519Sign(B.priv, canonicalCardPayload(payload));
    const r = await deliverWorldCard(payload, sig);
    expect(r.ok).toBe(true);

    // 我方世界模式扫描 → 卡片置顶 (reason=card)
    const s = await scanOpportunities();
    expect(s.ok).toBe(true);
    const cardOpp = s.results.find((x) => x.reason === 'card');
    expect(cardOpp).toBeTruthy();
    expect(cardOpp!.card?.verification).toBe('verified');
    expect(cardOpp!.card?.provider?.did).toBe(B_DID);
    expect(cardOpp!.card?.media).toHaveLength(4);
    // 多模态四种格式
    const types = cardOpp!.card!.media.map((m) => m.type);
    expect(types).toContain('text');
    expect(types).toContain('image');
    expect(types).toContain('audio');
    expect(types).toContain('video');

    // 桌面读出链路 (CLI world card list 同源)
    const cards = await listWorldCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('本周设计稿交付');
    expect(cards[0].media).toHaveLength(4);
  });

  it('伪造签名卡片 → 不接受 (世界流不出现)', async () => {
    const payload = {
      protocol: CARD_PROTOCOL,
      title: '伪造卡片',
      summary: '别信我',
      media: [{ type: 'text', url: 'https://evil.example/x', mime: 'text/plain', name: 'x.txt' }],
      provider: { did: B_DID, name: '冒充者' },
      issuedAt: new Date().toISOString(),
    };
    const sig = Buffer.from('f'.repeat(64)).toString('base64');
    const r = await deliverWorldCard(payload, sig);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('签名无效');
    const s = await scanOpportunities();
    expect(s.results.find((x) => x.reason === 'card')).toBeUndefined();
  });
});