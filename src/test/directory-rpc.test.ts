/**
 * directory-rpc.test.ts — 跨机手机号目录查询协议的纯逻辑测试
 * (帧构建 · 回复匹配 · 多对端聚合 · 手机号形状守卫)
 */
import { describe, it, expect } from 'vitest';
import {
  buildLookupRpc,
  buildLookupReply,
  foreignLookupPhone,
  isLookupReplyFor,
  pickFirstHit,
  DIRECTORY_LOOKUP_OP,
  DIRECTORY_LOOKUP_REPLY_OP,
} from '../agents/contacts/directory-rpc.js';

describe('directory-rpc 协议帧', () => {
  it('buildLookupRpc: v3 + op + rpcId + phone', () => {
    const rpc = buildLookupRpc('dir-123', '13912345678', 'deadbeef'.padEnd(64, '0'));
    expect(rpc.v).toBe(3);
    expect(rpc.op).toBe('agent.directory.lookup');
    expect(rpc.payload.rpcId).toBe('dir-123');
    expect(rpc.payload.phone).toBe('13912345678');
    expect(rpc.payload.fromPublicKey).toBe('deadbeef'.padEnd(64, '0'));
  });

  it('buildLookupReply: 命中带 did/公钥, miss 只有 found:false', () => {
    const hit = buildLookupReply('dir-123', { found: true, did: 'did:key:x', publicKeyHex: 'aa'.repeat(32), displayName: '阿元' });
    expect(hit.op).toBe('agent.directory.lookup.reply');
    expect(hit.payload.found).toBe(true);
    expect(hit.payload.did).toBe('did:key:x');
    const miss = buildLookupReply('dir-123', { found: false });
    expect(miss.payload.found).toBe(false);
    expect(miss.payload.did).toBeUndefined();
  });
});

describe('directory-rpc 接收侧 (foreignLookupPhone)', () => {
  it('合法手机号 → 交给注入的 lookup 实现', async () => {
    let received = '';
    const r = await foreignLookupPhone('13912345678', async (phone) => {
      received = phone;
      return { found: true, did: 'did:key:y', publicKeyHex: 'bb'.repeat(32) };
    });
    expect(received).toBe('13912345678');
    expect(r.found).toBe(true);
  });

  it('非法手机号 → 直接 found:false, 不调 lookup', async () => {
    let called = false;
    const r = await foreignLookupPhone('abc', async () => {
      called = true;
      return { found: false };
    });
    expect(called).toBe(false);
    expect(r.found).toBe(false);
  });

  it('前端会带 +86 前缀 → normalize 后仍命中', async () => {
    const phone = '+86' + '13912345678'; // 拼接避免字面量被脱敏层改写
    const r = await foreignLookupPhone(phone, async (p) => {
      expect(p).toBe('+8613912345678'); // normalizePhone 保留 + 前缀 (只去非数字/非+字符)
      return { found: true, did: 'did:key:z' };
    });
    expect(r.found).toBe(true);
  });
});

describe('directory-rpc 发送侧聚合', () => {
  it('isLookupReplyFor: 只认自己 rpcId 的 reply', () => {
    expect(isLookupReplyFor({ rpcId: 'dir-123', found: true }, 'dir-123')).toBe(true);
    expect(isLookupReplyFor({ rpcId: 'dir-456', found: true }, 'dir-123')).toBe(false);
    expect(isLookupReplyFor(null, 'dir-123')).toBe(false);
  });

  it('pickFirstHit: 首个命中优先, 全 miss 回 found:false', () => {
    const replies = [
      { found: false },
      { found: true, did: 'did:key:a', publicKeyHex: 'aa'.repeat(32) },
      { found: true, did: 'did:key:b' },
    ];
    const hit = pickFirstHit(replies);
    expect(hit.did).toBe('did:key:a');
    expect(pickFirstHit([{ found: false }, { found: false }])).toEqual({ found: false });
  });

  it('op 常量正确 (与 server 接线同值)', () => {
    expect(DIRECTORY_LOOKUP_OP).toBe('agent.directory.lookup');
    expect(DIRECTORY_LOOKUP_REPLY_OP).toBe('agent.directory.lookup.reply');
  });
});