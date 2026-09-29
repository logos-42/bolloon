/**
 * address-binding.test.ts — 地址↔DID 绑定登记 (`diap-address-binding/1`) 的聚焦测试
 *
 * 这条链路只讲一句话: **两侧都签了、两侧都验过, 才算数**。
 * 任何一个方向单独成立都不够 —— DID 签名只证明"这个 DID 认领这个地址", 地址签名只证明
 * "这个地址同意被这样认领"; 少了哪一侧, 声明都可以由另一方凭空造出来。
 *
 * 因此本文件里**每一条拒绝用例都单独钉住一个方向**:
 *   · 只改地址不改签名 ⇒ 拒    · 只改 DID ⇒ 拒
 *   · sig_addr 换成别人 ⇒ 拒   · 过期 ⇒ 拒
 *   · nonce 重放 ⇒ 拒          · 非 canonical 序列化版本 ⇒ 拒
 * 并额外钉住: 名字(label) 必须被签名覆盖 (否则"出名字但没验名字"); 只有**已验签**的绑定
 * 才产出对外短写 (`name_short` / `did_short`), 且短写里**不含** DID 形态与 0x40 地址。
 *
 * 全程 0 网络 / 0 链上 / 0 真钱: 钥匙用 `Wallet.createRandom()` 与 `crypto.randomBytes` 现造,
 * 目录在临时 HOME 里。**本文件不读也不碰任何真实钱包文件**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Wallet } from 'ethers';

import {
  ADDRESS_BINDING_PROTOCOL, ADDRESS_BINDING_SOURCE, BINDINGS_DIRNAME, BINDING_INDEX_FILENAME,
  DEFAULT_BINDING_CHAIN_ID,
  buildBindingStatement, canonicalBindingStatement, addressBindingId, canonicalBindingLabeled,
  createAddressBinding, verifyAddressBinding, payerIdentityOf,
  shortAgentName, didShort, didFromEd25519PublicKey, addressHash,
  writeBindingRecord, readBindingRecord, rebuildBindingIndex, readBindingIndex,
  loadPayerIdentityIndex, buildPublicBindingProjection,
  type AddressBindingRecord, type AddressBindingStatement,
} from '../agents/identity/address-binding.js';
import { ed25519Sign, ed25519Verify, canonicalize } from '../agents/x402/paid-info-protocol.js';
import { KeyManager } from '@diap/sdk';

// ── 现造身份 (不读任何真实钥匙文件) ──────────────────────────────────────────
function makeDid(): { did: string; publicKeyHex: string; privateKeyHex: string; seed: Uint8Array } {
  const kp = KeyManager.generate();
  return {
    did: kp.did,
    publicKeyHex: Buffer.from(kp.publicKey).toString('hex'),
    privateKeyHex: Buffer.from(kp.privateKey).toString('hex'),
    seed: Uint8Array.from(Buffer.from(kp.privateKey)),
  };
}

const ADDR_A = '0x6a3f797592bed028f6afd6da82339c8e815480eb';
const ADDR_B = '0x1111111111111111111111111111111111111111';

let HOME = '';

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-bind-'));
});
afterEach(() => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

const dir = () => path.join(HOME, '.bolloon', BINDINGS_DIRNAME);

/** 造一份真绑定 (双侧签名) */
async function makeBinding(opts: {
  address?: string; label?: string | null; expiresAt?: string | null; nonce?: string; issuedAt?: string; chainId?: number;
} = {}) {
  const did = makeDid();
  const w = Wallet.createRandom();
  const address = opts.address ?? w.address.toLowerCase();
  const rec = await createAddressBinding({
    did: did.did,
    didPrivateKeyHex: did.privateKeyHex,
    didPublicKeyHex: did.publicKeyHex,
    addressPrivateKeyHex: w.privateKey,
    address,
    label: opts.label === undefined ? 'x402-buyer-test' : opts.label,
    expiresAt: opts.expiresAt ?? null,
    nonce: opts.nonce,
    issuedAt: opts.issuedAt,
    chainId: opts.chainId,
  });
  return { rec, did, wallet: w };
}

/** 深拷贝一条记录 (用例里改一份不影响另一份) */
const clone = (r: AddressBindingRecord): AddressBindingRecord => JSON.parse(JSON.stringify(r));

// ───────────────────────────────────────────────────────── 1. 声明正文与 canonical

describe('声明正文 (冻结) 与 canonical 序列化', () => {
  it('正文的 7 个键与顺序无关, canonical 出来逐字节稳定 (键排序 + 无空格)', () => {
    const stmt: AddressBindingStatement = {
      protocol: ADDRESS_BINDING_PROTOCOL, did: makeDid().did, address: ADDR_A,
      chainId: DEFAULT_BINDING_CHAIN_ID, issuedAt: '2026-09-29T00:00:00.000Z', expiresAt: null,
      nonce: 'a'.repeat(32),
    };
    const shuffled = { nonce: stmt.nonce, expiresAt: null, chainId: 8453, address: ADDR_A, did: stmt.did, issuedAt: stmt.issuedAt, protocol: stmt.protocol } as any;
    const a = canonicalBindingStatement(stmt);
    const b = canonicalBindingStatement(shuffled);
    expect(a).toBe(b);
    expect(a).not.toContain(' ');
    // 顺序 = 字母序
    expect(Object.keys(JSON.parse(a))).toEqual(['address', 'chainId', 'did', 'expiresAt', 'issuedAt', 'nonce', 'protocol']);
    expect(JSON.parse(a).chainId).toBe(8453);
  });

  it('正文形状: 地址必须全小写 · chainId 正整数 · nonce 32 位 hex · did 要 did:key:z…', () => {
    const did = makeDid().did;
    const ok = () => buildBindingStatement({ did, address: ADDR_A, nonce: 'b'.repeat(32) });
    expect(() => buildBindingStatement({ did, address: ADDR_A.toUpperCase(), nonce: 'b'.repeat(32) })).not.toThrow();
    expect(ok().address).toBe(ADDR_A);
    expect(() => buildBindingStatement({ did, address: '0xZZZ', nonce: 'b'.repeat(32) })).toThrow(/address/);
    expect(() => buildBindingStatement({ did, address: ADDR_A, chainId: 0, nonce: 'b'.repeat(32) })).toThrow(/chainId/);
    expect(() => buildBindingStatement({ did, address: ADDR_A, nonce: 'zz' })).toThrow(/nonce/);
    expect(() => buildBindingStatement({ did: 'did:web:example.com', address: ADDR_A, nonce: 'b'.repeat(32) })).toThrow(/did/);
  });

  it('id = ab- + sha256(canonical) 前 16 位; 改一个字节就换 id', () => {
    const did = makeDid().did;
    const s1 = canonicalBindingStatement(buildBindingStatement({ did, address: ADDR_A, nonce: 'c'.repeat(32) }));
    const s2 = canonicalBindingStatement(buildBindingStatement({ did, address: ADDR_B, nonce: 'c'.repeat(32) }));
    expect(addressBindingId(s1)).toMatch(/^ab-[0-9a-f]{16}$/);
    expect(addressBindingId(s1)).not.toBe(addressBindingId(s2));
  });

  it('公钥派生 did:key 与 KeyManager 的 did 逐字相同 (核对 did ↔ 公钥自洽的尺子是同一把)', () => {
    const d = makeDid();
    expect(didFromEd25519PublicKey(d.publicKeyHex)).toBe(d.did);
  });
});

// ───────────────────────────────────────────────────────── 2. 双侧签名

describe('双侧签名', () => {
  it('两侧都过才算过 —— createAddressBinding 自验通过 + verify ok=true, 且两侧分别报 true', async () => {
    const { rec } = await makeBinding();
    const v = await verifyAddressBinding(rec);
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.sig_did_ok).toBe(true);
    expect(v.sig_addr_ok).toBe(true);
    expect(v.label_covered).toBe(true);
    expect(v.address).toBe(rec.statement.address);
    // 两枚签名是**两份不同的密码学** (一个 base64 Ed25519, 一个 0x…65 字节 EIP-191)
    expect(rec.sig_did).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(rec.sig_addr).toMatch(/^0x[0-9a-f]{130}$/);
    expect(rec.verified_checks).toContain('sig_did');
    expect(rec.verified_checks).toContain('sig_addr');
    expect(rec.verified_checks).toContain('label_covered');
  });

  it('只有一侧签名 (缺 sig_did) ⇒ 拒, 且**不**静默降级为可信', async () => {
    const { rec } = await makeBinding();
    const bad = clone(rec);
    delete (bad as any).sig_did;
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.sig_did_ok).toBe(false);
    expect(v.reasons).toContain('sig_did');
  });

  it('只有一侧签名 (缺 sig_addr) ⇒ 拒 (地址主人没同意被认领)', async () => {
    const { rec } = await makeBinding();
    const bad = clone(rec);
    delete (bad as any).sig_addr;
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.sig_addr_ok).toBe(false);
    expect(v.reasons).toContain('sig_addr');
  });

  it('DID 签名用**另一把** DID 私钥 ⇒ 拒', async () => {
    const { rec } = await makeBinding();
    const other = makeDid();
    const bad = clone(rec);
    bad.sig_did = await ed25519Sign(other.seed, rec.statement_json);
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.sig_did_ok).toBe(false);
    expect(v.sig_addr_ok).toBe(true);        // 地址侧照旧是好的 —— 两侧独立判定
  });

  it('sig_addr 换成别人 ⇒ 拒 (恢复出的地址 ≠ 声明地址)', async () => {
    const { rec } = await makeBinding();
    const stranger = Wallet.createRandom();
    const bad = clone(rec);
    bad.sig_addr = await stranger.signMessage(rec.statement_json);
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.sig_addr_ok).toBe(false);
    expect(v.reasons).toContain('sig_addr');
  });

  it('两条签名**互换** (地址私钥签的那份当 sig_did) ⇒ 拒', async () => {
    const { rec } = await makeBinding();
    const bad = clone(rec);
    const t = bad.sig_did; bad.sig_did = bad.sig_addr; bad.sig_addr = t;
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.sig_did_ok).toBe(false);
    expect(v.sig_addr_ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────── 3. 篡改 (只改声明不改签名)

describe('篡改声明正文 (签名照旧)', () => {
  it('只改地址、不改签名 ⇒ 拒 (canonical 重算与签过的那份不一致)', async () => {
    const { rec } = await makeBinding();
    const bad = clone(rec);
    bad.statement.address = ADDR_B;                    // 正文被改, statement_json 保持原样 (签名对象没变)
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('statement_canonical');
    expect(v.reasons).toContain('id_matches_statement');
    // 签名是"对 canonical 重算的字节串"验的 ⇒ 正文被换掉后签名也复现不出来 (两道闸一起响, 不是二选一)
    expect(v.sig_did_ok).toBe(false);
    expect(v.sig_addr_ok).toBe(false);
  });

  it('只改 DID、不改签名 ⇒ 拒 (且 did ↔ 公钥 自洽校验同时判红)', async () => {
    const { rec } = await makeBinding();
    const bad = clone(rec);
    bad.statement.did = makeDid().did;
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('did_matches_public_key');
    expect(v.reasons).toContain('statement_canonical');
  });

  it('改 chainId / expiresAt / issuedAt 任一项 ⇒ 拒 (同一道 canonical 闸)', async () => {
    const { rec } = await makeBinding();
    for (const mutate of [
      (r: AddressBindingRecord) => { r.statement.chainId = 84532; },
      (r: AddressBindingRecord) => { r.statement.issuedAt = '2020-01-01T00:00:00.000Z'; },
      (r: AddressBindingRecord) => { r.statement.expiresAt = '2099-01-01T00:00:00.000Z'; },
      (r: AddressBindingRecord) => { r.statement.nonce = 'f'.repeat(32); },
    ]) {
      const bad = clone(rec);
      mutate(bad);
      const v = await verifyAddressBinding(bad);
      expect(v.ok, JSON.stringify(bad.statement)).toBe(false);
      expect(v.reasons).toContain('statement_canonical');
    }
  });

  it('把 did_public_key 换成另一把公钥 (签名照旧) ⇒ 拒', async () => {
    const { rec } = await makeBinding();
    const bad = clone(rec);
    bad.did_public_key = makeDid().publicKeyHex;
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('sig_did');
    expect(v.reasons).toContain('did_matches_public_key');
  });
});

// ───────────────────────────────────────────────────────── 4. canonical 版本

describe('非 canonical 序列化版本', () => {
  it('用带空格/键序不同的 JSON 当签名对象 (两侧都真签了它) ⇒ 仍然拒', async () => {
    const did = makeDid();
    const w = Wallet.createRandom();
    const statement = buildBindingStatement({ did: did.did, address: w.address.toLowerCase(), nonce: 'd'.repeat(32) });
    // 手工做一份**非 canonical** 的字节串: 键序打乱 + 带空格; 两侧都对它签名 (所以这不是"签名错")
    const nonCanonical = JSON.stringify({
      did: statement.did, protocol: statement.protocol, address: statement.address,
      nonce: statement.nonce, chainId: statement.chainId, issuedAt: statement.issuedAt, expiresAt: statement.expiresAt,
    }, null, 1);
    expect(nonCanonical).not.toBe(canonicalBindingStatement(statement));
    const rec: AddressBindingRecord = {
      schemaVersion: 1, protocol: ADDRESS_BINDING_PROTOCOL,
      id: addressBindingId(nonCanonical),
      statement,
      statement_json: nonCanonical,
      did_public_key: did.publicKeyHex,
      sig_did: await ed25519Sign(did.seed, nonCanonical),
      sig_addr: await w.signMessage(nonCanonical),
      verified_at: new Date().toISOString(),
    };
    const v = await verifyAddressBinding(rec);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('statement_canonical');
    expect(v.reasons).toContain('id_matches_statement');
    // 反证: 同一份正文用 canonical 字节串签就过 (说明判据卡的是"序列化版本", 不是"签名方式")
    const good = clone(rec);
    good.statement_json = canonicalBindingStatement(statement);
    good.id = addressBindingId(good.statement_json);
    good.sig_did = await ed25519Sign(did.seed, good.statement_json);
    good.sig_addr = await w.signMessage(good.statement_json);
    expect((await verifyAddressBinding(good)).ok).toBe(true);
  });

  it('statement_json 与 statement 都是 canonical, 但两者描述的不是同一条正文 ⇒ 拒', async () => {
    const a = await makeBinding();
    const b = await makeBinding();
    const bad = clone(a.rec);
    bad.statement = clone(b.rec).statement;            // 换了正文
    // statement_json 仍是 a 的 → canonical 重算对不上
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('statement_canonical');
  });
});

// ───────────────────────────────────────────────────────── 5. 过期 / nonce 重放

describe('时效与一次性 nonce', () => {
  it('已过期 ⇒ 拒 (签名两侧照样是好的, 但登记不再成立)', async () => {
    const { rec } = await makeBinding({ expiresAt: '2027-01-01T00:00:00.000Z' });
    // 造的时候是有效的 (自验过); 到了 2030 年再验 —— 签名仍然成立, 是**时效**这一条判红
    const v = await verifyAddressBinding(rec, { now: Date.parse('2030-01-01T00:00:00.000Z') });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('not_expired');
    expect(v.sig_did_ok).toBe(true);
    expect(v.sig_addr_ok).toBe(true);
  });

  it('已经过期的绑定连造都造不出来 (createAddressBinding 自验就拒, 不留一份废绑定)', async () => {
    await expect(makeBinding({ expiresAt: '2020-01-01T00:00:00.000Z' })).rejects.toThrow(/not_expired/);
  });

  it('expiresAt=null = 不过期; 未到期的照样过', async () => {
    const now = Date.parse('2026-09-29T00:00:00.000Z');
    const a = await makeBinding({ expiresAt: null });
    expect((await verifyAddressBinding(a.rec, { now })).ok).toBe(true);
    const b = await makeBinding({ expiresAt: '2027-01-01T00:00:00.000Z' });
    expect((await verifyAddressBinding(b.rec, { now })).ok).toBe(true);
  });

  it('nonce 重放: 同一枚 nonce 被第二条绑定用掉 ⇒ 拒 (并指名 owner)', async () => {
    const nonce = 'e'.repeat(32);
    const first = await makeBinding({ nonce });
    const second = await makeBinding({ nonce });          // 另一把 DID + 另一个地址, 同 nonce
    const nonces = { [nonce]: first.rec.id };
    expect((await verifyAddressBinding(first.rec, { nonces })).ok).toBe(true);
    const v = await verifyAddressBinding(second.rec, { nonces });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('nonce_unused');
    expect(v.checks.find((c) => c.name === 'nonce_unused')?.detail).toContain(first.rec.id);
  });

  it('不给 nonce 索引时这一条"没跑"(如实标注, 不假装验过)', async () => {
    const { rec } = await makeBinding();
    const v = await verifyAddressBinding(rec);
    const c = v.checks.find((x) => x.name === 'nonce_unused');
    expect(c?.ok).toBe(true);
    expect(c?.detail).toContain('没跑');
  });
});

// ───────────────────────────────────────────────────────── 6. 名字必须被签名覆盖

describe('名字 (label) 的签名覆盖', () => {
  it('带 label 但有 label_sig ⇒ 过; label_covered=true', async () => {
    const { rec } = await makeBinding({ label: 'x402-buyer-test' });
    const v = await verifyAddressBinding(rec);
    expect(v.ok).toBe(true);
    expect(v.label_covered).toBe(true);
    expect(await ed25519Verify(rec.did_public_key, canonicalBindingLabeled(rec.statement, rec.label!), rec.label_sig!)).toBe(true);
  });

  it('改了 label 但 label_sig 照旧 ⇒ 拒 (**名字不能单独改**)', async () => {
    const { rec } = await makeBinding({ label: 'alice' });
    const bad = clone(rec);
    bad.label = 'bob';
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('label_covered');
    expect(v.label_covered).toBe(false);
  });

  it('有 label 却把 label_sig 删掉 ⇒ 拒 (不是"只是不出名字"这么轻)', async () => {
    const { rec } = await makeBinding({ label: 'alice' });
    const bad = clone(rec);
    delete (bad as any).label_sig;
    const v = await verifyAddressBinding(bad);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('label_covered');
  });

  it('没有 label 的绑定照旧只要两枚签名', async () => {
    const { rec } = await makeBinding({ label: null });
    const v = await verifyAddressBinding(rec);
    expect(v.ok).toBe(true);
    expect(v.label_covered).toBeNull();
    expect(v.reasons).toEqual([]);
  });

  it('名字短写: 清洗非法字符 + 截断, 绝不产出 0x / did: / 空格', () => {
    expect(shortAgentName('  x402-buyer-test  ')).toBe('x402-buyer-test');
    expect(shortAgentName('a b')).toBe('a_b');
    expect(shortAgentName(ADDR_A)).toBe('0x6a3f797592bed028f6afd6da82339c8e815480eb'.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24));
    expect(shortAgentName('did:key:z6Mkabc', 'fallback')).not.toContain('did:');
    expect(shortAgentName('', 'x'.repeat(50))).toBe('x'.repeat(24));
    expect(shortAgentName('', '')).toBe('agent');
    expect(shortAgentName('名字-一号')).toBe('名字-一号');
  });

  it('DID 短写: 去掉 did:key: 前缀取前 12 字符 (带动"页面上不许出现 DID 形态"这一条)', () => {
    const d = makeDid().did;
    const s = didShort(d);
    expect(d.startsWith('did:key:z')).toBe(true);
    expect(s).toBe(d.slice('did:key:'.length, 'did:key:'.length + 12));
    expect(s).not.toContain('did:');
    expect(s).toHaveLength(12);
  });
});

// ───────────────────────────────────────────────────────── 7. 绑定库 (落盘/索引/加载)

describe('绑定库: 落盘 · 索引 · 加载 (硬闸)', () => {
  it('写 → 读 → 重建索引: nonces 记账 + 同 id 不许覆盖', async () => {
    const { rec } = await makeBinding();
    const { file, index } = await writeBindingRecord(rec, { dir: dir() });
    expect(file).toBe(path.join(dir(), `${rec.id}.json`));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).id).toBe(rec.id);
    expect(readBindingRecord(file).sig_addr).toBe(rec.sig_addr);
    // 0600 (里面没有私钥, 但仍是私有事实)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(index.nonces[rec.statement.nonce]).toBe(rec.id);
    expect(index.bindings).toHaveLength(1);
    await expect(writeBindingRecord(rec, { dir: dir() })).rejects.toThrow(/已存在/);
    // 索引文件可读回
    const again = readBindingIndex({ dir: dir() });
    expect(again?.bindings[0]?.did_short).toBe(didShort(rec.statement.did));
  });

  it('加载给快照用: 只出已验签的一条; 被改过的文件**不进表**并如实记账', async () => {
    const good = await makeBinding({ label: 'good-one' });
    await writeBindingRecord(good.rec, { dir: dir() });
    // 手工塞一条"验不过"的: 改了地址 + 换 nonce (换 id 以写成**另一份文件**, 不覆盖上面那份)
    const tampered = clone(good.rec);
    tampered.statement.address = ADDR_B;
    tampered.statement.nonce = 'a'.repeat(32);
    tampered.id = addressBindingId(canonicalBindingStatement(tampered.statement));
    fs.writeFileSync(path.join(dir(), `${tampered.id}.json`), JSON.stringify(tampered, null, 2));
    await rebuildBindingIndex({ dir: dir() });

    const idx = await loadPayerIdentityIndex({ dir: dir(), now: Date.now() });
    expect(idx.loaded).toBe(2);
    expect(idx.verified).toBe(1);
    expect(idx.rejected).toHaveLength(1);
    expect(idx.rejected[0].reasons).toContain('statement_canonical');
    expect(Object.keys(idx.byAddress)).toEqual([good.rec.statement.address]);
    const ident = idx.byAddress[good.rec.statement.address];
    expect(ident).toEqual({
      name_short: 'good-one',
      did_short: didShort(good.rec.statement.did),
      verified: true,
      method: ADDRESS_BINDING_PROTOCOL,
      source: ADDRESS_BINDING_SOURCE,
    });
    // 硬闸: 对外短写里不许有 DID 形态 / 地址
    const blob = JSON.stringify(ident);
    expect(blob).not.toMatch(/did:/);
    expect(blob).not.toMatch(/0x[0-9a-fA-F]{40}/);
    // 口径: 必须自述"链下登记"
    expect(idx.label.zh).toContain('链下登记');
    expect(idx.note.zh).toContain('不是链上事实');
  });

  it('库里为空 / 目录不存在 ⇒ 空表 + 说得清的 reason (不猜、不报 0=没有智能体付款)', async () => {
    const idx = await loadPayerIdentityIndex({ dir: path.join(HOME, 'nope') });
    expect(idx.loaded).toBe(0);
    expect(idx.byAddress).toEqual({});
    expect(idx.reason).toContain('未建');
    // 空库也有 reason, 而且说的是"空"不是"没人付款"
    await rebuildBindingIndex({ dir: dir() });                     // 建出 index.json (0 条)
    const empty = await loadPayerIdentityIndex({ dir: dir() });
    expect(empty.reason).toContain('为空');
    expect(empty.loaded).toBe(0);
  });

  it('两份**都验得过**的文件共用一枚 nonce ⇒ 两条都拒 (分不清谁是先来的就不猜, fail-closed)', async () => {
    const nonce = 'b'.repeat(32);
    const a = await makeBinding({ nonce, label: 'first' });
    const b = await makeBinding({ nonce, label: 'second' });     // 另一把 DID + 另一个地址, 同一枚 nonce
    await writeBindingRecord(a.rec, { dir: dir() });
    await writeBindingRecord(b.rec, { dir: dir() });
    const idx = await loadPayerIdentityIndex({ dir: dir(), now: Date.now() });
    expect(idx.loaded).toBe(2);
    expect(idx.verified).toBe(0);
    expect(idx.byAddress).toEqual({});
    expect(idx.rejected.map((r) => r.reasons).flat()).toContain('nonce_unused');
  });

  it('对外投影 (publish): 只出短写, 地址只以哈希出现', async () => {
    const { rec } = await makeBinding({ label: 'proj-one' });
    await writeBindingRecord(rec, { dir: dir() });
    const proj = await buildPublicBindingProjection({ dir: dir() });
    expect(proj.count).toBe(1);
    expect(proj.protocol).toBe(ADDRESS_BINDING_PROTOCOL);
    expect(proj.kind).toBe('off-chain-registration');
    const row = proj.bindings[0];
    expect(row.name_short).toBe('proj-one');
    expect(row.address_hash).toBe(addressHash(rec.statement.address));
    const blob = JSON.stringify(proj);
    expect(blob).not.toMatch(/0x[0-9a-fA-F]{40}/);      // 地址不出
    expect(blob).not.toMatch(/did:/);                    // 完整 DID 不出
    expect(blob).not.toContain(rec.statement.address);
  });

  it('payerIdentityOf 给的就是那 5 个键 (页面/快照的字段集合冻结)', async () => {
    const { rec } = await makeBinding({ label: 'k' });
    expect(Object.keys(payerIdentityOf(rec)).sort()).toEqual(['did_short', 'method', 'name_short', 'source', 'verified']);
    expect(payerIdentityOf(rec).source).toBe(ADDRESS_BINDING_SOURCE);
    expect(payerIdentityOf(rec).verified).toBe(true);
  });

  it('createAddressBinding 的错误路径: 地址与私钥不对应 / DID 与公钥不自洽 ⇒ 拒 (不生成任何记录)', async () => {
    const did = makeDid();
    const w = Wallet.createRandom();
    await expect(createAddressBinding({
      did: did.did, didPrivateKeyHex: did.privateKeyHex, didPublicKeyHex: did.publicKeyHex,
      addressPrivateKeyHex: w.privateKey, address: ADDR_A,          // 地址与这把钥匙不符
    })).rejects.toThrow(/不对应/);
    await expect(createAddressBinding({
      did: did.did, didPrivateKeyHex: did.privateKeyHex, didPublicKeyHex: makeDid().publicKeyHex,
      addressPrivateKeyHex: w.privateKey, address: w.address.toLowerCase(),
    })).rejects.toThrow(/不自洽/);
  });

  it('canonicalize 是同一个实现 (绑定与信封同源, 不另造一套序列化)', () => {
    const stmt = buildBindingStatement({ did: makeDid().did, address: ADDR_A, nonce: 'a'.repeat(32) });
    expect(canonicalBindingStatement(stmt)).toBe(canonicalize(stmt));
    expect(canonicalBindingStatement(stmt)).toBe(JSON.stringify(JSON.parse(canonicalBindingStatement(stmt))));
  });
});

// ───────────────────────────────────────────────────────── 8. 付款行集成 (快照/页面)

import {
  buildPaymentRowsFromTransfers, usablePayerIdentity, payerIdentityIssues,
  PAYER_IDENTITY_METHOD, PAYER_IDENTITY_SOURCE,
  type PayerIdentityShort,
} from '../agents/network-pulse.js';

const PAY_TO = '0xb4e9dcf79055a8232670ebb1c8c664dff4e70066';   // 本机收款地址 (watch)

/** 造一条转账索引条目 (只造测试要用的字段; 其余按形状补齐) */
function transfer(from: string, i: number) {
  return {
    key: `${`0x${String(i).padStart(2, '0')}`.padEnd(66, 'a')}:${i}`,
    blockNumber: 51901934 + i, blockHash: `0x${'b'.repeat(64)}`,
    txHash: `0x${String(i).padStart(2, '0').repeat(32)}`, txIndex: 0, logIndex: i,
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    from, to: PAY_TO, value: '10000', direction: 'in' as const,
    confirmations: 100, finality: 'finalized' as const, firstSeenAt: Date.parse('2026-09-29T03:00:00Z'),
  };
}

function rowsFor(payerIdentities: Record<string, PayerIdentityShort> | null, from: string) {
  return buildPaymentRowsFromTransfers([transfer(from, 1)] as any, {
    chainId: 8453, watchAddresses: [PAY_TO], ownAddresses: [], escrowAddress: null,
    tokenSymbol: 'USDC', tokenDecimals: 6, x402Txs: null, payerIdentities,
  });
}

describe('付款行集成: 只有**已验签**的绑定才让行里多出一个短写名字', () => {
  it('已验签绑定的地址 ⇒ 行里多出 payer_identity (5 个键, 全是短写); 别的地址 ⇒ 该键**不出现**', async () => {
    const { rec } = await makeBinding({ label: 'x402-buyer-test' });
    await writeBindingRecord(rec, { dir: dir() });
    const idx = await loadPayerIdentityIndex({ dir: dir(), now: Date.now() });
    expect(idx.verified).toBe(1);

    const hit = rowsFor(idx.byAddress, rec.statement.address);
    expect(hit).toHaveLength(1);
    expect(hit[0].payer_identity).toEqual({
      name_short: 'x402-buyer-test',
      did_short: didShort(rec.statement.did),
      verified: true,
      method: PAYER_IDENTITY_METHOD,
      source: PAYER_IDENTITY_SOURCE,
    });
    // 行里不许出现地址/DID 形态 (只出短写)
    const blob = JSON.stringify(hit[0]);
    expect(blob).not.toMatch(/did:/);
    expect(blob).not.toContain(rec.statement.address);

    // 库里没有这个地址 (ADDR_B) ⇒ 硬闸: 键**整个不出现** (不是空名、不是 null、不猜)
    const miss = rowsFor(idx.byAddress, ADDR_B);
    expect(miss).toHaveLength(1);
    expect('payer_identity' in miss[0]).toBe(false);
    // 传 null (本机没有绑定库) ⇒ 同样不出现
    expect('payer_identity' in rowsFor(null, rec.statement.address)[0]).toBe(false);
  });

  it('**未验签/被篡改**的绑定 ⇒ 该付款行不出名字、不出 DID (连短写都没有)', async () => {
    const good = await makeBinding({ label: 'tampered-after-sign' });
    await writeBindingRecord(good.rec, { dir: dir() });
    // 落盘之后再改地址 (签名不再成立): 库还在, 但重验不过
    const tampered = { ...good.rec, statement: { ...good.rec.statement, address: ADDR_B } };
    fs.writeFileSync(path.join(dir(), `${tampered.id}.json`), JSON.stringify(tampered, null, 2));
    const idx = await loadPayerIdentityIndex({ dir: dir(), now: Date.now() });
    expect(idx.verified).toBe(0);
    expect(idx.rejected.length).toBeGreaterThan(0);
    expect(idx.byAddress).toEqual({});
    // 无论用被改的那个地址还是原地址去查, 都没有名字
    for (const a of [good.rec.statement.address, ADDR_B]) {
      const rows = rowsFor(idx.byAddress, a);
      expect('payer_identity' in rows[0]).toBe(false);
    }
  });

  it('usablePayerIdentity 的三道硬闸: verified/来源/短写形状 —— 任一不过就**丢掉整条**', () => {
    const ok = { name_short: 'ok-name', did_short: 'z6MkqX2ejeXv', verified: true, method: PAYER_IDENTITY_METHOD, source: PAYER_IDENTITY_SOURCE };
    expect(usablePayerIdentity(ok)).toEqual(ok);
    const bad: Array<[string, any]> = [
      ['verified=false (没验过)', { ...ok, verified: false }],
      ['verified 缺失', { name_short: 'x', did_short: 'z6MkqX2ejeXv', method: PAYER_IDENTITY_METHOD, source: PAYER_IDENTITY_SOURCE }],
      ['method 不是本协议', { ...ok, method: 'something-else/1' }],
      ['source 不是 off-chain-signed', { ...ok, source: 'on-chain' }],
      ['名字里塞了地址', { ...ok, name_short: ADDR_A }],
      ['did_short 带 did: 前缀', { ...ok, did_short: 'did:key:z6Mk' }],
      ['did_short 形状不对 (空)', { ...ok, did_short: '' }],
      ['名字带空格', { ...ok, name_short: 'a b' }],
      ['不是对象', 'x'],
      ['null', null],
    ];
    for (const [what, v] of bad) expect(usablePayerIdentity(v), what).toBeNull();
  });

  it('快照一致性门 payerIdentityIssues: 干净快照过; 四类注入逐条判红', () => {
    const good = { name_short: 'x402-buyer-test', did_short: 'z6MkqX2ejeXv', verified: true as const, method: PAYER_IDENTITY_METHOD, source: PAYER_IDENTITY_SOURCE };
    const baseSnap: any = {
      payer_identity_scope: {
        loaded: 1, verified: 1, rejected: 0, rejected_reasons: [], rows_with_identity: 1,
        reason: '重验 1 条 → 通过 1 条', label: { zh: '链下登记(可离线验签)', en: 'off-chain registration (verifiable offline)' },
        note: { zh: 'x', en: 'x' }, method: PAYER_IDENTITY_METHOD, source: PAYER_IDENTITY_SOURCE,
      },
      confirmed_activity: [{ kind: 'payment_in', payer_identity: good }],
    };
    expect(payerIdentityIssues(baseSnap)).toEqual([]);
    // ① 未验签的行
    expect(payerIdentityIssues({ ...baseSnap, confirmed_activity: [{ kind: 'payment_in', payer_identity: { ...good, verified: false } }] }).join(' ')).toMatch(/只有已验签的绑定才许出行/);
    // ② 短写里塞了地址 / DID 形态
    expect(payerIdentityIssues({ ...baseSnap, confirmed_activity: [{ kind: 'payment_in', payer_identity: { ...good, name_short: ADDR_A } }] }).length).toBeGreaterThan(0);
    // ③ 有身份却没有口径
    expect(payerIdentityIssues({ confirmed_activity: [{ kind: 'payment_in', payer_identity: good }] }).join(' ')).toMatch(/却没有 payer_identity_scope/);
    // ④ 口径计数与行里真数出来的对不上 (同一批行必须相等)
    expect(payerIdentityIssues({ ...baseSnap, payer_identity_scope: { ...baseSnap.payer_identity_scope, rows_with_identity: 3 } }).join(' ')).toMatch(/rows_with_identity=3/);
    // ⑤ 口径说 verified=0 却行里有身份
    expect(payerIdentityIssues({ ...baseSnap, payer_identity_scope: { ...baseSnap.payer_identity_scope, verified: 0 } }).join(' ')).toMatch(/verified=0 却行里有身份/);
    // ⑥ 身份跑到非付款行上
    expect(payerIdentityIssues({ ...baseSnap, confirmed_activity: [{ kind: 'task_created', payer_identity: good }] }).join(' ')).toMatch(/只有付款行才有"付款方"/);
  });
});
