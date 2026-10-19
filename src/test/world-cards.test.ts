/**
 * world-cards.test.ts — 世界卡片信箱 (2026-10-19, leo: 对方智能体往世界模式传卡片, 内容格式不限)
 *
 * 对方/外部智能体用 DIAP Ed25519 身份签名投递一张「世界卡片」(bolloon-world-card/1)
 *   到本机世界模式 → 验签通过入库 (~/.bolloon/world/cards/<id>.json) → 世界流 reason='card' 置顶。
 * 卡片内容格式不限: media[] 里每一项可是 text / audio / image / video (url + mime + name)。
 *
 * 验签同源: 真 Ed25519 keypair + 真 did:key + canonicalCardPayload (与机会信箱同构)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { deliverWorldCard, listWorldCards, CARD_PROTOCOL, canonicalCardPayload, type CardPayload } from '../agents/world-cards.js';
import { ed25519Sign } from '../agents/x402/paid-info-protocol.js';
import { scanOpportunities } from '../agents/opportunity-match.js';

// 真 Ed25519 密钥对 (匹配的一对)
const kp = crypto.generateKeyPairSync('ed25519');
const TEST_PUB = Buffer.from(kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
const TEST_PRIV = Buffer.from(kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32));

/** 从 32B 公钥构造真 did:key (multicodec 0xed01 + 公钥 → base58btc) */
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
const TEST_DID = didKeyFromPublicKey(TEST_PUB);

const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;
let fakeHome: string;

async function makeFakeHome(): Promise<string> {
  const dir = path.join(os.tmpdir(), `bolloon-card-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeEach(async () => {
  fakeHome = await makeFakeHome();
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(fakeHome, { recursive: true, force: true });
});

/** 构造一张多模态卡片 (文本/文档/音频/图片/视频 全带上) */
function makeCardPayload(over: Partial<CardPayload> = {}): CardPayload {
  return {
    protocol: CARD_PROTOCOL,
    title: over.title ?? '对方智能体传来的设计稿',
    summary: over.summary ?? '请查收: 设计文档 + 预览图 + 演示视频 + 语音说明。',
    media: [
      { type: 'text', url: 'https://example.com/design.md', mime: 'text/markdown', name: 'design.md' },
      { type: 'image', url: 'https://example.com/preview.png', mime: 'image/png', name: 'preview.png' },
      { type: 'audio', url: 'https://example.com/voice.mp3', mime: 'audio/mpeg', name: 'voice-note.mp3' },
      { type: 'video', url: 'https://example.com/demo.mp4', mime: 'video/mp4', name: 'demo.mp4' },
    ],
    provider: { did: TEST_DID, name: '对方智能体' },
    issuedAt: new Date().toISOString(),
    ...over,
  };
}

describe('world-cards (世界卡片信箱)', () => {
  it('验签通过 → 入库 (verified) + 多模态 media 原样保留', async () => {
    const payload = makeCardPayload();
    const sig = await ed25519Sign(TEST_PRIV, canonicalCardPayload(payload));
    const r = await deliverWorldCard(payload, sig);
    expect(r.ok).toBe(true);
    expect(r.card).toBeTruthy();
    expect(r.card!.verification).toBe('verified');
    expect(r.card!.id.startsWith('card_')).toBe(true);
    expect(r.card!.media).toHaveLength(4);
    expect(r.card!.media.map((m) => m.type)).toEqual(['text', 'image', 'audio', 'video']);
    // 落盘
    const list = await listWorldCards();
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('对方智能体传来的设计稿');
    expect(list[0].provider.did).toBe(TEST_DID);
    expect(list[0].media[0]).toEqual({ type: 'text', url: 'https://example.com/design.md', mime: 'text/markdown', name: 'design.md' });
  });

  it('签名无效 → 拒绝 (不污染世界流)', async () => {
    const payload = makeCardPayload();
    const badSig = Buffer.from('a'.repeat(64)).toString('base64');
    const r = await deliverWorldCard(payload, badSig);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('签名无效');
    expect(await listWorldCards()).toHaveLength(0);
  });

  it('公钥不可解析 DID → 拒绝', async () => {
    const payload = makeCardPayload();
    payload.provider = { did: 'did:key:znotabase58', name: '坏来源' };
    const sig = await ed25519Sign(TEST_PRIV, canonicalCardPayload(payload));
    const r = await deliverWorldCard(payload, sig);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无法解析');
  });

  it('协议不匹配 → 拒绝', async () => {
    const payload = makeCardPayload({ protocol: 'bolloon-wrong-protocol/9' });
    const sig = await ed25519Sign(TEST_PRIV, canonicalCardPayload(payload));
    const r = await deliverWorldCard(payload, sig);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('协议不匹配');
  });

  it('canonicalCardPayload 稳定 — 键序不影响签名验证', async () => {
    const p1: CardPayload = makeCardPayload();
    const p2: CardPayload = {
      protocol: p1.protocol,
      title: p1.title,
      summary: p1.summary,
      media: p1.media,
      provider: p1.provider,
      issuedAt: p1.issuedAt,
    };
    p2.title = p1.title; // 同值不同键序排列
    expect(canonicalCardPayload(p1)).toBe(canonicalCardPayload(p2));
  });

  it('scanOpportunities 合并 verified 世界卡片 (reason=card, 优先级最高)', async () => {
    const payload = makeCardPayload();
    const sig = await ed25519Sign(TEST_PRIV, canonicalCardPayload(payload));
    const r = await deliverWorldCard(payload, sig);
    expect(r.ok).toBe(true);
    const s = await scanOpportunities();
    expect(s.ok).toBe(true);
    expect(s.results.length).toBeGreaterThan(0);
    expect(s.results[0].reason).toBe('card');
    expect(s.results[0].card?.verification).toBe('verified');
    expect(s.results[0].card?.provider?.did).toBe(TEST_DID);
    expect(s.results[0].card?.media).toHaveLength(4);
    // 世界卡片优先级 = 卡片 > 信箱 > 搜索 > 本地
    const reasons = s.results.map((x) => x.reason);
    expect(reasons[0]).toBe('card');
  });

  it('scope=public 公域卡片: 验签入库 + scope 保留', async () => {
    const payload = makeCardPayload({ scope: 'public' });
    const sig = await ed25519Sign(TEST_PRIV, canonicalCardPayload(payload));
    const r = await deliverWorldCard(payload, sig);
    expect(r.ok).toBe(true);
    expect(r.card!.verification).toBe('verified');
    expect(r.card!.scope).toBe('public');
    const list = await listWorldCards();
    expect(list.length).toBe(1);
    expect(list[0].scope).toBe('public');
  });

  it('scope 缺省 = private (好友定向)', async () => {
    const payload = makeCardPayload(); // 不传 scope
    const sig = await ed25519Sign(TEST_PRIV, canonicalCardPayload(payload));
    const r = await deliverWorldCard(payload, sig);
    expect(r.ok).toBe(true);
    expect(r.card!.scope).toBe('private');
  });

  it('公域卡片进世界流且透传 scope (前端据此标 🌐 公域)', async () => {
    const payload = makeCardPayload({ scope: 'public', title: '公域公告: 开源合作招募' });
    const sig = await ed25519Sign(TEST_PRIV, canonicalCardPayload(payload));
    await deliverWorldCard(payload, sig);
    const s = await scanOpportunities();
    const cardOpp = s.results.find((x) => x.reason === 'card');
    expect(cardOpp).toBeTruthy();
    expect(cardOpp!.card?.scope).toBe('public');
    expect(cardOpp!.title).toBe('公域公告: 开源合作招募');
  });

  it('scope 签名覆盖: 改 scope 后验签失败 (防伪造公域标记)', async () => {
    const payload = makeCardPayload({ scope: 'private' });
    const sig = await ed25519Sign(TEST_PRIV, canonicalCardPayload(payload));
    const tampered = { ...payload, scope: 'public' as const };
    const r = await deliverWorldCard(tampered, sig); // 签名是按 private 载荷签的, 改成 public 不匹配
    expect(r.ok).toBe(false);
    expect(r.error).toContain('签名无效');
  });
});