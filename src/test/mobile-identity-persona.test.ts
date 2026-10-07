/**
 * 手机端三块功能端到端验证 (2026-10-07)
 * 模拟浏览器环境 (fake-indexeddb + Node WebCrypto + Node localStorage):
 *   1. DIAP 身份: KeyManager 生成 did:key + 持久化 IndexedDB
 *   2. 签名: signWithIdentity (noble signAsync) + verifyIdentitySignature
 *   3. persona 性格: 保存/读取/注入系统提示
 *   4. 邮箱/手机号附带条件: updateIdentityProfile
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';

// Node/vitest 无真实 localStorage → 用内存 polyfill (真浏览器是原生 localStorage)
const memStore = new Map<string, string>();
const fakeLS = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => { memStore.set(k, v); },
  removeItem: (k: string) => { memStore.delete(k); },
};
(globalThis as any).window = { localStorage: fakeLS };
(globalThis as any).localStorage = fakeLS;
(globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
(globalThis as any).atob = (s: string) => Buffer.from(s, 'base64').toString('binary');

import { ensureIdentity, identityStatus, signWithIdentity, verifyIdentitySignature, updateIdentityProfile } from '../web/mobile-agent.ts';
import { loadPersona, savePersona, buildPersonaPrompt, resetPersona } from '../web/mobile-persona.ts';

describe('手机端 DIAP 身份 + persona 性格 + 附带条件', () => {
  it('身份: KeyManager 生成 did:key + 持久化', async () => {
    const id = await ensureIdentity();
    expect(id.did).toMatch(/^did:key:z6Mk/);
    expect(id.publicKey.length).toBe(64);
    expect(id.privateKey.length).toBe(64);
    expect(id.name).toBe('blln-mobile');
    // 幂等
    const id2 = await ensureIdentity();
    expect(id2.did).toBe(id.did);
  });

  it('签名: signWithIdentity + verifyIdentitySignature (含篡改检测)', async () => {
    const id = await ensureIdentity();
    const payload = '手机端身份签名测试-2026-10-07';
    const s = await signWithIdentity(payload);
    expect(s.alg).toBe('ed25519');
    expect(s.did).toBe(id.did);
    expect(s.signature.length).toBeGreaterThan(20);
    expect(await verifyIdentitySignature(payload, s.signature, id.publicKey)).toBe(true);
    expect(await verifyIdentitySignature('被篡改的载荷', s.signature, id.publicKey)).toBe(false);
  });

  it('persona 性格: 保存/持久化/注入系统提示/恢复默认', () => {
    const dflt = loadPersona();
    expect(dflt.personality).toContain('严谨');
    const saved = savePersona({ name: '小B', personality: '活泼、话多、喜欢用表情', style: '简洁', values: ['本地优先', '诚实'], interests: ['P2P', 'AI'], boundaries: ['不编造'] });
    expect(saved.name).toBe('小B');
    const reloaded = loadPersona();
    expect(reloaded.name).toBe('小B');
    expect(reloaded.personality).toContain('活泼');
    const prompt = buildPersonaPrompt(reloaded);
    expect(prompt).toContain('你的名字: 小B');
    expect(prompt).toContain('活泼');
    expect(prompt).toContain('不编造');
    resetPersona();
    expect(loadPersona().name).toBe('blln-mobile');
  });

  it('附带条件: 邮箱/手机号/备注 保存 + identityStatus 返回', async () => {
    const upd = await updateIdentityProfile({ email: 'me@example.com', phone: '13800000000', note: '主设备' });
    expect(upd.email).toBe('me@example.com');
    expect(upd.phone).toBe('13800000000');
    const st = await identityStatus();
    expect(st.email).toBe('me@example.com');
    expect(st.phone).toBe('13800000000');
    expect(st.did).toMatch(/^did:key:z6Mk/);
    expect(st.publicKey.length).toBe(64);
  });
});
