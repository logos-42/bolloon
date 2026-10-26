import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KeyManager } from '@diap/sdk';
import {
  publishEntry,
  lookupPhone,
  canonicalDirectoryEntry,
  signDirectoryEntry,
  verifyDirectoryEntry,
} from '../agents/contacts/human-directory.js';

let tmpHome: string;
let ownerDid: string;
let ownerKey: Uint8Array;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-dir-sig-'));
  const idDir = path.join(tmpHome, '.bolloon');
  fs.mkdirSync(idDir, { recursive: true });
  const kp: any = KeyManager.generate();
  ownerDid = String(kp.did);
  ownerKey = kp.privateKey as Uint8Array;
  await (KeyManager as any).saveToFile(kp, path.join(idDir, 'identity.json'));
});

describe('目录条目 owner_sig (手机号/邮箱绑定带 DID 签名)', () => {
  it('发布用自己的 DID 签名, 查询 verified=true', async () => {
    const entry = await publishEntry('+86 131-1571-8038', ownerDid, { homeDir: tmpHome });
    expect(entry.ownerSig).toBeTruthy();
    const hit = await lookupPhone('+8613115718038', tmpHome);
    expect(hit.found).toBe(true);
    expect(hit.verified).toBe(true);
    expect(hit.did).toBe(ownerDid);
  });

  it('邮箱同样签名可验', async () => {
    const entry = await publishEntry('leo@example.com', ownerDid, { homeDir: tmpHome });
    expect(entry.ownerSig).toBeTruthy();
    const hit = await lookupPhone('LEO@EXAMPLE.COM', tmpHome);
    expect(hit.found).toBe(true);
    expect(hit.verified).toBe(true);
  });

  it('用别人 DID 发布 → 签不上 (ownerSig 空, verified=false)', async () => {
    const entry = await publishEntry('+86 139-0000-1111', 'did:key:someoneElse', { homeDir: tmpHome });
    expect(entry.ownerSig).toBe('');
    const hit = await lookupPhone('+8613900001111', tmpHome);
    expect(hit.found).toBe(true);
    expect(hit.verified).toBe(false);
  });

  it('无本机身份 → 降级 ownerSig 空, verified=false (诚实失败, 不冒充)', async () => {
    const noIdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-dir-noin-'));
    fs.mkdirSync(path.join(noIdHome, '.bolloon'), { recursive: true });
    const entry = await publishEntry('+86 137-2222-3333', 'did:key:localNoId', { homeDir: noIdHome });
    expect(entry.ownerSig).toBe('');
    const hit = await lookupPhone('+8613722223333', noIdHome);
    expect(hit.verified).toBe(false);
  });

  it('篡改条目声明 (改 did) → 验签失败; 原条目仍验过', async () => {
    const entry = await publishEntry('+86 135-4444-5555', ownerDid, { homeDir: tmpHome });
    expect(await verifyDirectoryEntry({ ...entry, did: 'did:key:tampered' })).toBe(false);
    expect(await verifyDirectoryEntry(entry)).toBe(true);
  });

  it('canonical 一致: 同内容签名/验签自洽', async () => {
    const base = {
      phoneHash: 'h', salt: 's', kind: 'phone' as const, did: ownerDid,
      publicKeyHex: 'abcd', displayName: 'X', publishedAt: '2026',
    };
    const sig = await signDirectoryEntry(base, ownerKey);
    expect(await verifyDirectoryEntry({ ...base, ownerSig: sig })).toBe(true);
    expect(canonicalDirectoryEntry(base)).toBe(canonicalDirectoryEntry({ ...base }));
  });
});
