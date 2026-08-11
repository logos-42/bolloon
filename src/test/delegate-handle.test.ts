import { describe, it, expect } from 'vitest';
import {
  createDelegateHandle,
  verifyDelegateHandle,
  DELEGATE_CONTRACT_VERSION,
} from '../external-engines/delegate-handle.js';

describe('delegate-handle (Hermes subagent_lifecycle 模式)', () => {
  it('create → verify 通过 (真实 handle)', () => {
    const h = createDelegateHandle({
      ownerDid: 'did:pi:agentA',
      engineId: 'opencode',
      correlationId: 'delegate:123:abc',
      model: 'deepseek-v4-flash',
    });
    expect(h.contractVersion).toBe(DELEGATE_CONTRACT_VERSION);
    expect(h.delegateId).toBeTruthy();
    expect(h.capability).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDelegateHandle(h)).toBe(true);
    expect(verifyDelegateHandle(h, 'did:pi:agentA')).toBe(true);
  });

  it('伪造 capability → 拒绝', () => {
    const h = createDelegateHandle({ ownerDid: 'did:pi:agentA', engineId: 'codex' });
    const forged = { ...h, capability: '0'.repeat(64) };
    expect(verifyDelegateHandle(forged)).toBe(false);
  });

  it('篡改 delegateId → 拒绝 (capability 不匹配)', () => {
    const h = createDelegateHandle({ ownerDid: 'did:pi:agentA', engineId: 'codex' });
    const tampered = { ...h, delegateId: 'another-id' };
    expect(verifyDelegateHandle(tampered)).toBe(false);
  });

  it('跨 owner (agent/channel) 使用 → 拒绝', () => {
    const h = createDelegateHandle({ ownerDid: 'did:pi:agentA', engineId: 'codex' });
    expect(verifyDelegateHandle(h, 'did:pi:agentB')).toBe(false);
  });

  it('contractVersion 不符 → 拒绝', () => {
    const h = createDelegateHandle({ ownerDid: 'did:pi:agentA', engineId: 'codex' });
    const old = { ...h, contractVersion: 0 };
    expect(verifyDelegateHandle(old)).toBe(false);
  });

  it('缺字段 / 类型不对 → 拒绝 (不猜)', () => {
    const h = createDelegateHandle({ ownerDid: 'did:pi:agentA', engineId: 'codex' });
    expect(verifyDelegateHandle({ ...h, createdAt: 'abc' as any })).toBe(false);
    expect(verifyDelegateHandle({ ...h, ownerDid: 42 as any })).toBe(false);
    expect(verifyDelegateHandle(null)).toBe(false);
    expect(verifyDelegateHandle(undefined)).toBe(false);
    expect(verifyDelegateHandle('string' as any)).toBe(false);
  });

  it('correlationId 保留在 handle 里', () => {
    const h = createDelegateHandle({
      ownerDid: 'did:pi:agentA',
      engineId: 'hermes',
      correlationId: 'delegate:999:xyz',
    });
    expect(h.correlationId).toBe('delegate:999:xyz');
  });
});
