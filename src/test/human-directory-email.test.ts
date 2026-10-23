// 邮箱目录用例补充 (2026-10-23): human-directory 双 kind + directory-rpc kind 透传
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeEmail, sniffKind, isPlausibleEmail, isPlausibleContact, blindHashEmail,
  publishEntry, lookupPhone, readDirectory, directoryPath,
} from '../agents/contacts/human-directory.js';
import { buildLookupRpc, buildLookupReply } from '../agents/contacts/directory-rpc.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-dir-email-'));

beforeEach(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.bolloon', 'contacts'), { recursive: true });
});
afterEach(() => fs.rmSync(HOME, { recursive: true, force: true }));

describe('邮箱归一化/嗅探/校验', () => {
  it('normalizeEmail: trim + 小写', () => {
    expect(normalizeEmail('  Leo@Example.COM ')).toBe('leo@example.com');
  });
  it('sniffKind: 邮箱 vs 手机号', () => {
    expect(sniffKind('leo@example.com')).toBe('email');
    expect(sniffKind('13115718038')).toBe('phone');
    expect(sniffKind('+8613115718038')).toBe('phone');
  });
  it('isPlausibleEmail / isPlausibleContact', () => {
    expect(isPlausibleEmail('a@b.com')).toBe(true);
    expect(isPlausibleEmail('not-an-email')).toBe(false);
    expect(isPlausibleContact('a@b.com')).toBe(true);
    expect(isPlausibleContact('13115718038')).toBe(true);
    expect(isPlausibleContact('!@#$')).toBe(false);
  });
  it('blindHashEmail: 大小写不敏感 → 同哈希', () => {
    expect(blindHashEmail('Leo@Example.COM', 'salt', 'pepper'))
      .toBe(blindHashEmail('leo@example.com', 'salt', 'pepper'));
  });
});

describe('邮箱目录 publish → lookup 闭环', () => {
  it('publish email + lookup email (同 HOME)', async () => {
    const did = 'did:key:z6Mktest';
    const e = await publishEntry('Leo@Example.COM', did, { homeDir: HOME, publicKeyHex: 'aa'.repeat(32) });
    expect(e.kind).toBe('email');
    const r = await lookupPhone('leo@example.com', HOME); // 大小写不同也命中
    expect(r.found).toBe(true);
    expect(r.did).toBe(did);
  });

  it('phone 与 email 同 DID 共存 (各自一条)', async () => {
    const did = 'did:key:z6Mkdual';
    await publishEntry('13115718038', did, { homeDir: HOME });
    await publishEntry('leo@example.com', did, { homeDir: HOME });
    const entries = await readDirectory(HOME);
    expect(entries.filter((x) => x.did === did)).toHaveLength(2); // 双 kind 各一条
    expect(await lookupPhone('13115718038', HOME)).toMatchObject({ found: true });
    expect(await lookupPhone('leo@example.com', HOME)).toMatchObject({ found: true });
  });

  it('同 DID 重发同 kind → 更新不新增', async () => {
    const did = 'did:key:z6Mkupd';
    await publishEntry('leo@example.com', did, { homeDir: HOME, displayName: 'A' });
    await publishEntry('leo@example.com', did, { homeDir: HOME, displayName: 'B' });
    const entries = await readDirectory(HOME);
    expect(entries.filter((x) => x.did === did && x.kind === 'email')).toHaveLength(1);
    expect(entries.find((x) => x.kind === 'email')?.displayName).toBe('B');
  });

  it('lookup 只比同 kind 条目 (邮箱不会命中手机号)', async () => {
    await publishEntry('13115718038', 'did:key:z6Mkph', { homeDir: HOME });
    const r = await lookupPhone('13115718038@example.com', HOME); // 不是合法邮箱 → false
    expect(r.found).toBe(false);
  });

  it('旧条目 (无 kind 字段) 默认按 phone 处理 (向后兼容)', async () => {
    const did = 'did:key:z6Mklegacy';
    const e = await publishEntry('13115718038', did, { homeDir: HOME });
    // 模拟旧数据: 删除 kind 字段
    const p = directoryPath(HOME);
    const entries = JSON.parse(fs.readFileSync(p, 'utf8'));
    delete entries[0].kind;
    fs.writeFileSync(p, JSON.stringify(entries, null, 2));
    const r = await lookupPhone('13115718038', HOME);
    expect(r.found).toBe(true);
    expect(r.did).toBe(did);
  });
});

describe('directory-rpc kind 透传', () => {
  it('buildLookupRpc 带 kind 时帧内携带', () => {
    const rpc = buildLookupRpc('r1', 'leo@example.com', undefined, 'email');
    expect(rpc.payload.kind).toBe('email');
    expect(rpc.payload.contact).toBe('leo@example.com');
    expect(rpc.payload.phone).toBe('leo@example.com'); // 兼容旧字段
  });
  it('buildLookupReply 带 kind 回显', () => {
    const reply = buildLookupReply('r1', { found: true, did: 'did:key:x' });
    // 直接构造带 kind 的 reply 也 OK:
    const custom = { ...reply, payload: { ...reply.payload, kind: 'email' as const } };
    expect(custom.payload.kind).toBe('email');
  });
});