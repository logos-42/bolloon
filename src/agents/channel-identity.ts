/**
 * 每个 channel 的**自己的**身份 (2026-10-01)。
 *
 * 用户实测: 两个不同 channel (agent_18cece3f / test-agent) 都答「我叫小龙」, 且 get_identity 返回
 *   `DID: `(空) —— 症状是"读身份的还有问题"。
 * 根因: index.ts 组装 identityDoc 时, 只有 channel 记录**同时**有 did 和 publicKey 才用它,
 *   否则落到 `agentIdentity`(进程级**共享**的一个) ⇒ 多个 channel 共用一个身份 ✗;
 *   而 channel 记录里还可能存着假 DID (`did:local:…`) ✗, 或干脆没 did (测试夹具建的) ✗。
 * 规矩: 身份归属**以 channel 的 agentId 为准** —— 每个 agent 用自己的真 did:key (落盘密钥),
 *   名字优先用该 agent 自己的 persona.json, 其次渠道名 (渠道名天然各不相同)。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 假的/垃圾 DID: 不该被当成身份用 (老代码自造过 did:local: / did:pi:) */
export function isUsableDid(did: unknown): boolean {
  const s = String(did ?? '').trim();
  if (!s) return false;
  return !/^did:(local|pi):/i.test(s);
}

/** channel 记录里的身份够不够用 (did 真 + 有公钥) */
export function channelIdentityUsable(ch: { did?: string; publicKey?: string } | null | undefined): boolean {
  return !!ch && isUsableDid(ch.did) && !!ch.publicKey;
}

/** 该 agent 自己的 persona.json 里的名字 (没有就 undefined) */
export function agentPersonaName(agentId: string, home = os.homedir()): string | undefined {
  const id = String(agentId || '').trim();
  if (!id) return undefined;
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_');
  try {
    const p = path.join(home, '.bolloon', 'persona', safe, 'persona.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const n = String(j?.name ?? '').trim();
    return n || undefined;
  } catch {
    return undefined;
  }
}

/**
 * channel 应该显示/使用什么名字。
 * 顺序: 该 agent 的 persona.json → channel 记录里的 persona.name → channel 名 → agentId
 * **绝不**回落到"某个全局身份的名字" —— 那正是"两个 channel 一个名"的来源。
 */
export function nameForChannel(
  ch: { name?: string; agentId?: string; persona?: { name?: string } } | null | undefined,
  agentId?: string,
  home = os.homedir(),
): string {
  const id = String(agentId || ch?.agentId || '').trim();
  return (
    (id ? agentPersonaName(id, home) : undefined) ||
    String(ch?.persona?.name ?? '').trim() ||
    String(ch?.name ?? '').trim() ||
    id ||
    'agent'
  );
}
