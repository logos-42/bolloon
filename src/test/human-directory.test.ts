/**
 * human-directory — 手机号 → DID 目录 (2026-10-11, phone-account-lookup-design 落点 A)
 * 验证: 盲化哈希确定性 / 发布-查询闭环 / 撤销 / 隐私 (无明文泄露)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  blindHash, genSalt, loadPepper, publishEntry, retractEntry,
  lookupPhone, readDirectory, isPlausiblePhone,
} from '../agents/contacts/human-directory.js';

let HOME: string;

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'humdir-'));
});

describe('human-directory P0 (落点 A)', () => {
  it('blindHash: 确定性 (同输入同输出) + 不同 salt 不同哈希', async () => {
    const pepper = await loadPepper(HOME);
    const salt = genSalt();
    const h1 = blindHash('13800000000', salt, pepper);
    const h2 = blindHash('13800000000', salt, pepper);
    expect(h1).toBe(h2); // 确定性
    const salt2 = genSalt();
    expect(blindHash('13800000000', salt2, pepper)).not.toBe(h1); // 不同 salt → 不同哈希
  });

  it('pepper: 首次生成 + 幂等复用 (同一路径两次读同值)', async () => {
    const p1 = await loadPepper(HOME);
    const p2 = await loadPepper(HOME);
    expect(p1).toBe(p2);
  });

  it('发布 → 查询闭环 (手机号找回 DID)', async () => {
    await publishEntry('13800000000', 'did:key:z6Mkabc', { displayName: '阿元', homeDir: HOME });
    const r = await lookupPhone('13800000000', HOME);
    expect(r.found).toBe(true);
    expect(r.did).toBe('did:key:z6Mkabc');
    expect(r.displayName).toBe('阿元');
  });

  it('未发布手机号 → not found (与不存在同义)', async () => {
    await publishEntry('13800000000', 'did:key:z6Mkabc', { homeDir: HOME });
    const r = await lookupPhone('13900000000', HOME);
    expect(r.found).toBe(false);
  });

  it('撤销 → 查询返回 not found (软删)', async () => {
    await publishEntry('13800000000', 'did:key:z6Mkabc', { homeDir: HOME });
    await retractEntry('did:key:z6Mkabc', HOME);
    const r = await lookupPhone('13800000000', HOME);
    expect(r.found).toBe(false);
    // 条目仍保留 (审计)
    const entries = await readDirectory(HOME);
    expect(entries[0].revokedAt).toBeTruthy();
  });

  it('同 DID 重发布 → 覆盖 (只有一条, 新 salt 新哈希)', async () => {
    await publishEntry('13800000000', 'did:key:same', { homeDir: HOME });
    await publishEntry('13911111111', 'did:key:same', { homeDir: HOME });
    const entries = await readDirectory(HOME);
    expect(entries).toHaveLength(1);
    expect(entries[0].phoneHash).not.toBe(await blindHash('13800000000', entries[0].salt, await loadPepper(HOME)));
    expect(await lookupPhone('13911111111', HOME)).toMatchObject({ found: true, did: 'did:key:same' });
  });

  it('隐私: 目录文件无明文手机号', async () => {
    await publishEntry('13812345678', 'did:key:z6Mkabc', { homeDir: HOME });
    const raw = fs.readFileSync(path.join(HOME, '.bolloon', 'contacts', 'human-directory.json'), 'utf8');
    expect(raw).not.toContain('13812345678'); // 明文不进目录
    expect(raw).toContain('phoneHash'); // 只有哈希
  });

  it('isPlausiblePhone: 合法/非法', () => {
    expect(isPlausiblePhone('13800000000')).toBe(true);
    expect(isPlausiblePhone('+8613800000000')).toBe(true);
    expect(isPlausiblePhone('123')).toBe(false);
    expect(isPlausiblePhone('abc')).toBe(false);
  });

  it('publishEntry 非法手机号/DID → 抛错', async () => {
    await expect(publishEntry('123', 'did:key:x', { homeDir: HOME })).rejects.toThrow();
    await expect(publishEntry('13800000000', 'not-a-did', { homeDir: HOME })).rejects.toThrow();
  });

  it('publicKeyHex: 显式传入 → 发布/查询打通 (手机号→公钥直达加好友)', async () => {
    await publishEntry('13800000000', 'did:key:z6Mkabc', { publicKeyHex: 'AB12'.repeat(16), homeDir: HOME });
    const r = await lookupPhone('13800000000', HOME);
    expect(r.found).toBe(true);
    expect(r.publicKeyHex).toBe('ab12'.repeat(16)); // 小写归一
  });

  it('publicKeyHex: 不传 → 缺省从本机 user.json(仅当存在且 64 hex)/否则 undefined', async () => {
    // 隔离 HOME 没有 user.json → undefined (不抛错)
    const r = await publishEntry('13800000000', 'did:key:d1', { homeDir: HOME });
    expect(r.publicKeyHex).toBeUndefined();
    // 显式传非法值 → 原样存 (格式由调用方负责)
    await publishEntry('13800000001', 'did:key:d2', { publicKeyHex: 'zz', homeDir: HOME });
    const r2 = await lookupPhone('13800000001', HOME);
    expect(r2.publicKeyHex).toBe('zz');
  });
});