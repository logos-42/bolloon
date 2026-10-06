/**
 * opportunity-inbox.test.ts — 机会信箱 (2026-10-05, leo: 别人主动投来的机会)
 *
 * 验签通过 → 入库并进世界流 · 签名无效/公钥不可解析 → 拒绝 (不可信来源不污染世界流)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { deliverOpportunity, listInboxOpportunities, INBOX_PROTOCOL, canonicalPayload } from '../agents/opportunity-inbox.js';
import { ed25519Sign, ed25519Verify } from '../agents/x402/paid-info-protocol.js';
import { scanOpportunities } from '../agents/opportunity-match.js';

// 真 Ed25519 密钥对 (crypto 生成, 匹配的一对) — 之前随意设的 TEST_PRIV/TEST_PUB 不是一对, 签名必验证失败
const kp = crypto.generateKeyPairSync('ed25519');
const TEST_PUB = Buffer.from(kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
const TEST_PRIV = Buffer.from(kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32));

/** 从 32B 公钥构造真 did:key (multicodec 0xed01 + 公钥 → base58btc) — 让 resolveDidPublicKey 能解析 */
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
  const dir = path.join(os.tmpdir(), `bolloon-inbox-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
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

function makePayload(over: Partial<{ title: string; summary: string; providerDid: string }> = {}) {
  return {
    protocol: INBOX_PROTOCOL,
    title: over.title ?? '寻找磁约束控制合作伙伴',
    summary: over.summary ?? '某大学实验室需要 AI magnetic control 合作',
    refs: ['https://example.edu/fusion-lab'],
    provider: { did: over.providerDid ?? TEST_DID, name: '测试实验室' },
    issuedAt: new Date().toISOString(),
  };
}

describe('opportunity-inbox (机会信箱)', () => {
  it('验签通过 → 入库 (verified)', async () => {
    const payload = makePayload();
    const sig = await ed25519Sign(TEST_PRIV, canonicalPayload(payload));
    const r = await deliverOpportunity(payload, sig);
    expect(r.ok).toBe(true);
    expect(r.opportunity).toBeTruthy();
    expect(r.opportunity!.verification).toBe('verified');
    expect(r.opportunity!.id.startsWith('inbox_')).toBe(true);
    // 落盘
    const list = await listInboxOpportunities();
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('寻找磁约束控制合作伙伴');
    expect(list[0].provider.did).toBe(TEST_DID);
  });

  it('签名无效 → 拒绝 (不污染世界流)', async () => {
    const payload = makePayload();
    const badSig = Buffer.from('a'.repeat(64)).toString('base64');
    const r = await deliverOpportunity(payload, badSig);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('签名无效');
    expect(await listInboxOpportunities()).toHaveLength(0);
  });

  it('canonicalPayload 稳定 — 键序不影响签名验证', async () => {
    const p1 = { protocol: INBOX_PROTOCOL, title: 'A', summary: 'B', refs: ['x'], provider: { did: TEST_DID }, issuedAt: '2026-10-05T00:00:00Z' };
    const p2 = { issuedAt: '2026-10-05T00:00:00Z', summary: 'B', refs: ['x'], provider: { did: TEST_DID }, title: 'A', protocol: INBOX_PROTOCOL };
    expect(canonicalPayload(p1)).toBe(canonicalPayload(p2));
  });

  it('scanOpportunities 合并 verified 信箱机会 (reason=inbox, 最前)', async () => {
    const payload = makePayload();
    const sig = await ed25519Sign(TEST_PRIV, canonicalPayload(payload));
    await deliverOpportunity(payload, sig);
    const r = await scanOpportunities();
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].reason).toBe('inbox');
    expect(r.results[0].inbox?.verification).toBe('verified');
    expect(r.results[0].inbox?.providerDid).toBe(TEST_DID);
  });
});