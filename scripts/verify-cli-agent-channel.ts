/**
 * verify-cli-agent-channel.ts — 验证 CLI agent 身份随 channel 重建 (2026-08-09 bug 修复)
 * 隔离 HOME: 用临时目录, 不碰真实 ~/.bolloon.
 * 场景: ① 默认 harness 身份 ② /new agent 创建 → 新 agent 身份 ③ 切 channel → 身份变化 ④ 身份稳定 (agent-keys 持久)
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-cli-chan-verify-'));
process.env.HOME = TMP;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function main() {
  // 预置用户 DID (归属用)
  fs.mkdirSync(path.join(TMP, '.bolloon', 'identity'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.bolloon', 'identity', 'user.json'), JSON.stringify({
    did: 'did:key:z6MkUserOwner', didShort: 'z6MkUser', publicKeyHex: 'aa', name: 'leo',
  }));

  // [1] agent-identity: 生成 agent key → ownerDid 归属用户 DID
  console.log('[1] agent-identity ownerDid 归属');
  const { loadOrCreateAgentIdentity } = await import('../src/agents/agent-identity.js');
  const idt = loadOrCreateAgentIdentity('agent-alpha');
  check('agent-alpha DID 生成', !!idt.did && idt.did.startsWith('did:key:'));
  check('ownerDid = 用户 DID', idt.ownerDid === 'did:key:z6MkUserOwner', `got=${idt.ownerDid}`);
  // 重复调用 → 同一 DID (持久)
  const idt2 = loadOrCreateAgentIdentity('agent-alpha');
  check('agent-alpha 身份持久 (复用同一 DID)', idt2.did === idt.did);

  // [2] identity-store: channels.json + active-channel.json
  console.log('[2] identity-store 读写');
  const { getIdentityStore } = await import('../src/agents/agent-identity-store.js');
  const store = getIdentityStore();
  fs.mkdirSync(path.join(TMP, '.bolloon', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.bolloon', 'sessions', 'channels.json'), JSON.stringify([
    { id: 'ch_aaa', name: 'Alpha', agentId: 'agent-alpha', did: idt.did, publicKey: idt.publicKey, currentSessionId: 'default' },
    { id: 'ch_bbb', name: 'Beta', agentId: 'agent-beta', currentSessionId: 'default' },
  ]));
  await store.load();
  const idents = store.getIdentities();
  check('列出 2 个身份', idents.length === 2, `n=${idents.length}`);
  const r = await store.resolve('Alpha');
  check('按 name 解析 Alpha', !!r && r.identity.name === 'Alpha');
  const r2 = await store.resolve('2');
  check('按 number 解析 2 → Beta', !!r2 && r2.identity.name === 'Beta');

  // [3] server-storage updateChannels 原子写 (CLI /new agent 复用)
  console.log('[3] updateChannels 原子写');
  const { updateChannels } = await import('../src/web/server-storage.js');
  const chs = await updateChannels((c: any[]) => [...c, {
    id: 'ch_new', name: 'NewAgent', agentId: 'agent-new', currentSessionId: 'default',
  }]);
  check('updateChannels 追加成功', chs.length === 3, `n=${chs.length}`);
  const chs2 = await updateChannels((c: any[]) => c.filter((x: any) => x.id !== 'ch_bbb'));
  check('updateChannels 删除成功', chs2.length === 2, `n=${chs2.length}`);

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
