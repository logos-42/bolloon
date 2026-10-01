/**
 * 每个 channel 自己的身份 (2026-10-01, 用户实测)。
 *
 * 症状: 两个不同 channel (agent_18cece3f / test-agent) 都答「我叫小龙」, get_identity 的 DID 还是空的。
 * 根因: 只有 channel 同时有 did + publicKey 才用 channel 身份, 否则落到**进程级共享**的 agentIdentity
 *   ⇒ 多个 channel 一个身份 ✗; channel 里还可能存着假 DID (did:local:…) 或没有 did。
 * 规矩: 身份归属以 channel 的 agentId 为准; 名字只用该 agent 自己的 persona.json 或渠道名。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUsableDid, channelIdentityUsable, agentPersonaName, nameForChannel } from '../agents/channel-identity.js';

let TMP = '';
const writePersona = (id: string, name: string) => {
  const dir = path.join(TMP, '.bolloon', 'persona', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ name }), 'utf-8');
};
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-channel-id-'));
  writePersona('agent-233', '233');
  writePersona('agent-xiaomi', 'xiaomi');
  // agent_18cece3f / test-agent 故意**没有** persona.json (真实状态就是这样)
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

describe('假 DID', () => {
  it('did:local: / did:pi: / 空 一律不可用', () => {
    for (const d of ['', '   ', 'did:local:ch_1790765316938', 'did:pi:ch_x', undefined, null]) expect(isUsableDid(d), `${d}`).toBe(false);
  });
  it('真 did:key 可用', () => expect(isUsableDid('did:key:z6Mkg2hYzB4e3mg')).toBe(true));
  it('channelIdentityUsable: 光有 did 不行, 还要有 publicKey', () => {
    expect(channelIdentityUsable({ did: 'did:key:z1', publicKey: 'abc' })).toBe(true);
    expect(channelIdentityUsable({ did: 'did:key:z1' })).toBe(false);            // 用户 ch_…28hyil 就是这种
    expect(channelIdentityUsable({ did: 'did:local:ch_1', publicKey: 'abc' })).toBe(false);
    expect(channelIdentityUsable(null)).toBe(false);
  });
});

describe('名字归属 (不再有共享名)', () => {
  it('有自己 persona.json 的 agent 用自己的名字', () => {
    expect(agentPersonaName('agent-233', TMP)).toBe('233');
    expect(nameForChannel({ name: '渠道名' }, 'agent-233', TMP)).toBe('233');
  });
  it('没有 persona.json ⇒ 用**渠道名** (渠道名天然不同), 不是任何全局名', () => {
    expect(nameForChannel({ name: '智能体', agentId: 'agent_18cece3f' }, 'agent_18cece3f', TMP)).toBe('智能体');
    expect(nameForChannel({ name: 'real test msg', agentId: 'test-agent' }, 'test-agent', TMP)).toBe('real test msg');
  });
  it('**决定性**: 两个不同 channel 必须得到两个不同的名字 (用户踩的就是这条)', () => {
    const a = nameForChannel({ name: '智能体', agentId: 'agent_18cece3f' }, 'agent_18cece3f', TMP);
    const b = nameForChannel({ name: 'real test msg', agentId: 'test-agent' }, 'test-agent', TMP);
    expect(a).not.toBe(b);
  });
  it('persona 里存的名字优先于 channel 记录里的旧 persona.name', () => {
    expect(nameForChannel({ name: 'x', persona: { name: '旧的' } }, 'agent-xiaomi', TMP)).toBe('xiaomi');
  });
  it('什么都没有 ⇒ 落到 agentId, 不落到空', () => {
    expect(nameForChannel({}, 'agent-zzz', TMP)).toBe('agent-zzz');
  });
});
